import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { ReconciliationAlert } from './reconciliation'

/**
 * (1) Un PAYOUT écrit sans transfert réglé est détecté par la réconciliation.
 * (2) Une TransferOutbox FAILED rejouée par le worker atteint SETTLED.
 *
 * Prérequis : DATABASE_URL → base waylo_test (cf. webhook.idempotence.test.ts).
 */

const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500
const PAYOUT_CENTS = BUDGET_CENTS - COMMISSION_CENTS

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

describe('TransferOutbox — worker de transfert & réconciliation', () => {
  let prisma: PrismaClient
  let escrowId: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma

    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.issuingAuthorizationLog.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.user.deleteMany()

    const buyer = await prisma.user.create({
      data: { email: 'buyer-outbox@test.waylo', kycStatus: 'VERIFIED' },
    })
    const traveler = await prisma.user.create({
      data: {
        email: 'traveler-outbox@test.waylo',
        kycStatus: 'VERIFIED',
        stripeAccountId: 'acct_test_outbox_traveler',
      },
    })
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'RELEASED',
        targetProduct: 'Sneakers exclusives',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Osaka',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    // Escrow libéré, ledger complet (invariant Σ OK) — mais AUCUN transfert réglé.
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: 'pi_waylo_outbox_test',
        capturedAmountCents: BUDGET_CENTS,
        status: 'RELEASED',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: 'idem_waylo_outbox_1',
      },
    })
    escrowId = escrow.id
    // Lignes antidatées AU-DELÀ de la fenêtre de grâce PAYOUT_NOT_SETTLED
    // (défaut 60 min) : un PAYOUT frais serait un transitoire normal, silencieux.
    const beyondGrace = new Date(Date.now() - 2 * 3600 * 1000)
    await prisma.ledgerEntry.createMany({
      data: [
        { escrowId, type: 'CAPTURE', amountCents: BUDGET_CENTS, createdAt: beyondGrace },
        { escrowId, type: 'PAYOUT', amountCents: PAYOUT_CENTS, createdAt: beyondGrace },
        { escrowId, type: 'COMMISSION', amountCents: COMMISSION_CENTS, createdAt: beyondGrace },
      ],
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('(1) réconciliation : un PAYOUT sans transfert réglé déclenche PAYOUT_NOT_SETTLED', async () => {
    const { runReconciliation } = await import('./reconciliation')

    const collected: ReconciliationAlert[] = []
    const alerts = await runReconciliation({
      prisma,
      onAlert: alert => collected.push(alert),
    })

    const notSettled = alerts.filter(a => a.code === 'PAYOUT_NOT_SETTLED')
    expect(notSettled).toHaveLength(1)
    expect(notSettled[0]?.details).toMatchObject({
      escrowId,
      payoutCents: PAYOUT_CENTS,
      settledCents: 0,
    })
    // Le hook configurable reçoit bien chaque alerte émise.
    expect(collected).toEqual(alerts)
    // L'invariant Σ est sain : pas de faux positif comptable.
    expect(alerts.filter(a => a.code === 'LEDGER_INVARIANT_BROKEN')).toHaveLength(0)
    // Détection only : le ledger n'a pas bougé.
    expect(await prisma.ledgerEntry.count({ where: { escrowId } })).toBe(3)
  })

  it('(2) worker : une TransferOutbox FAILED rejouée atteint SETTLED', async () => {
    const { runTransferWorkerOnce } = await import('./transfer-worker')
    const { runReconciliation } = await import('./reconciliation')

    const outbox = await prisma.transferOutbox.create({
      data: {
        escrowId,
        destinationAccountId: 'acct_test_outbox_traveler',
        amountCents: PAYOUT_CENTS,
        status: 'FAILED',
        attempts: 1,
        lastError: 'simulated stripe outage',
        idempotencyKey: `transfer_release_${escrowId}`,
      },
    })
    // Backoff : rendre la ligne FAILED immédiatement éligible (updatedAt dans le passé).
    await prisma.$executeRaw`
      UPDATE "TransferOutbox" SET "updatedAt" = now() - interval '1 hour' WHERE "id" = ${outbox.id}
    `

    // Fake Stripe : capture les arguments, rend un transfert.
    const calls: Array<{ amount: number; destination: string; idempotencyKey: string }> = []
    const fakeStripe = {
      transfers: {
        create: async (
          params: { amount: number; currency: string; destination: string },
          options: { idempotencyKey: string },
        ): Promise<{ id: string }> => {
          calls.push({
            amount: params.amount,
            destination: params.destination,
            idempotencyKey: options.idempotencyKey,
          })
          return { id: 'tr_test_settled_1' }
        },
      },
    }

    const result = await runTransferWorkerOnce({ prisma, stripe: fakeStripe })
    expect(result).toEqual({ settled: 1, failed: 0, abandoned: 0 })

    // Le transfert est parti avec l'idempotencyKey DE LA LIGNE (rejouable sans double versement).
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      amount: PAYOUT_CENTS,
      destination: 'acct_test_outbox_traveler',
      idempotencyKey: `transfer_release_${escrowId}`,
    })

    const after = await prisma.transferOutbox.findUniqueOrThrow({ where: { id: outbox.id } })
    expect(after.status).toBe('SETTLED')
    expect(after.stripeTransferId).toBe('tr_test_settled_1')

    // Tick suivant : plus rien d'éligible — pas de double exécution.
    expect(await runTransferWorkerOnce({ prisma, stripe: fakeStripe })).toEqual({
      settled: 0,
      failed: 0,
      abandoned: 0,
    })
    expect(calls).toHaveLength(1)

    // Boucle fermée : la réconciliation ne signale plus le PAYOUT.
    const alerts = await runReconciliation({ prisma, onAlert: () => {} })
    expect(alerts.filter(a => a.code === 'PAYOUT_NOT_SETTLED')).toHaveLength(0)
  })
})
