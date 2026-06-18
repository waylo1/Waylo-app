import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { OpsAlert } from '../alerts'
import type { PenaltyDebitStripeClient } from './penalty.worker'

/**
 * Worker de PONCTION DE PÉNALITÉ (Sprint 15) — exécution différée de la ponction
 * 200% posée par l'arbitrage de fraude (`PenaltyDebitOutbox`).
 *
 * (1) Cas passant : carte voyageur débitée off-session (penalty_debit_<id>,
 *     montant 200%), PUIS hold acheteur annulé (penalty_release_<missionId>) →
 *     escrow HELD → CANCELLED, outbox SETTLED + PI enregistré. Rejeu : rien d'éligible.
 * (2) Carte refusée : create throw → outbox FAILED (attempts++), AUCUNE libération
 *     du hold (escrow toujours HELD), aucune annulation Stripe.
 * (3) Abandon (maxAttempts=1) : 1er échec → ABANDONED + alerte critique
 *     PENALTY_DEBIT_ABANDONED, hold acheteur toujours en place.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const BUDGET_CENTS = 10_000 // Valeur Objet
const COMMISSION_CENTS = 1_500 // Frais Service Plateforme
const BASE_CENTS = BUDGET_CENTS + COMMISSION_CENTS // 11_500
const PENALTY_CENTS = BASE_CENTS * 2 // 23_000 (200%)

describe('PenaltyDebitOutbox — worker de ponction de pénalité (Sprint 15)', () => {
  let prisma: PrismaClient
  let escrowId: string
  let missionId: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await wipe()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function wipe(): Promise<void> {
    await prisma.penaltyDebitOutbox.deleteMany()
    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.issuingAuthorizationLog.deleteMany()
    await prisma.review.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.user.deleteMany()
  }

  /**
   * Mission DISPUTED_FRAUD (post-arbitrage) + escrow HELD (hold acheteur jamais
   * capturé) + voyageur muni de sa carte de garantie + ponction 200% PENDING.
   * `withCard=false` simule un voyageur sans carte (anomalie structurelle).
   */
  async function seedPenalty(withCard = true): Promise<void> {
    const buyer = await prisma.user.create({ data: { email: `buyer-pen-${Date.now()}@test.waylo` } })
    const traveler = await prisma.user.create({
      data: {
        email: `traveler-pen-${Date.now()}@test.waylo`,
        ...(withCard
          ? {
              stripePaymentMethodId: `pm_pen_${Date.now()}`,
              stripeCustomerId: `cus_pen_${Date.now()}`,
            }
          : {}),
      },
    })
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'DISPUTED_FRAUD',
        targetProduct: 'Article détourné',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    missionId = mission.id
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_pen_${mission.id}`,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    escrowId = escrow.id
    await prisma.penaltyDebitOutbox.create({
      data: { missionId: mission.id, userId: traveler.id, amountCents: PENALTY_CENTS },
    })
  }

  beforeEach(async () => {
    await wipe()
  })

  it('(1) cas passant : débit off-session 200% + libération du hold → escrow CANCELLED, outbox SETTLED', async () => {
    const { runPenaltyWorkerOnce } = await import('./penalty.worker')
    await seedPenalty()

    const creates: Array<{
      amount: number
      currency: string
      customer?: string
      payment_method: string
      confirm: boolean
      off_session: boolean
      idempotencyKey: string
    }> = []
    const cancels: Array<{ id: string; idempotencyKey: string }> = []
    const fakeStripe: PenaltyDebitStripeClient = {
      paymentIntents: {
        create: async (params, options) => {
          creates.push({ ...params, idempotencyKey: options.idempotencyKey })
          return { id: 'pi_penalty_settled_1', status: 'succeeded' }
        },
        cancel: async (id, _params, options) => {
          cancels.push({ id, idempotencyKey: options.idempotencyKey })
          return { id }
        },
      },
    }

    const outbox = await prisma.penaltyDebitOutbox.findUniqueOrThrow({ where: { missionId } })
    const result = await runPenaltyWorkerOnce({ prisma, stripe: fakeStripe })
    expect(result).toEqual({ settled: 1, failed: 0, abandoned: 0 })

    // Débit off-session de la carte voyageur : montant 200%, clé déterministe.
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({
      amount: PENALTY_CENTS,
      currency: 'eur',
      payment_method: expect.stringMatching(/^pm_pen_/),
      confirm: true,
      off_session: true,
      idempotencyKey: `penalty_debit_${outbox.id}`,
    })
    expect(creates[0]?.customer).toMatch(/^cus_pen_/)

    // Hold acheteur annulé APRÈS le débit réussi, clé déterministe par mission.
    expect(cancels).toEqual([
      { id: `pi_pen_${missionId}`, idempotencyKey: `penalty_release_${missionId}` },
    ])

    // Escrow libéré (jamais capturé) et ponction soldée + PI enregistré.
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('CANCELLED')
    const after = await prisma.penaltyDebitOutbox.findUniqueOrThrow({ where: { id: outbox.id } })
    expect(after.status).toBe('SETTLED')
    expect(after.stripePaymentIntentId).toBe('pi_penalty_settled_1')

    // Tick suivant : plus rien d'éligible — pas de double débit.
    expect(await runPenaltyWorkerOnce({ prisma, stripe: fakeStripe })).toEqual({
      settled: 0,
      failed: 0,
      abandoned: 0,
    })
    expect(creates).toHaveLength(1)
  })

  it('(2) carte refusée : outbox FAILED (attempts++), hold acheteur intact (escrow HELD), aucune annulation', async () => {
    const { runPenaltyWorkerOnce } = await import('./penalty.worker')
    await seedPenalty()

    const cancels: Array<{ id: string }> = []
    const fakeStripe: PenaltyDebitStripeClient = {
      paymentIntents: {
        create: async () => {
          throw new Error('card_declined')
        },
        cancel: async (id) => {
          cancels.push({ id })
          return { id }
        },
      },
    }

    const result = await runPenaltyWorkerOnce({ prisma, stripe: fakeStripe })
    expect(result).toEqual({ settled: 0, failed: 1, abandoned: 0 })

    const after = await prisma.penaltyDebitOutbox.findUniqueOrThrow({ where: { missionId } })
    expect(after.status).toBe('FAILED')
    expect(after.attempts).toBe(1)
    expect(after.lastError).toContain('card_declined')
    expect(after.stripePaymentIntentId).toBeNull()

    // Le hold acheteur N'EST PAS libéré tant que la ponction n'a pas réussi.
    expect(cancels).toHaveLength(0)
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('HELD')
  })

  it('(3) abandon (maxAttempts=1) : ABANDONED + alerte critique PENALTY_DEBIT_ABANDONED, hold intact', async () => {
    const { runPenaltyWorkerOnce } = await import('./penalty.worker')
    await seedPenalty()

    const alerts: OpsAlert[] = []
    const fakeStripe: PenaltyDebitStripeClient = {
      paymentIntents: {
        create: async () => {
          throw new Error('card_declined')
        },
      },
    }

    const result = await runPenaltyWorkerOnce({
      prisma,
      stripe: fakeStripe,
      maxAttempts: 1,
      onAlert: a => alerts.push(a),
    })
    expect(result).toEqual({ settled: 0, failed: 0, abandoned: 1 })

    const after = await prisma.penaltyDebitOutbox.findUniqueOrThrow({ where: { missionId } })
    expect(after.status).toBe('ABANDONED')
    expect(after.attempts).toBe(1)

    // Alerte critique « needs human », une seule fois.
    const abandoned = alerts.filter(a => a.code === 'PENALTY_DEBIT_ABANDONED')
    expect(abandoned).toHaveLength(1)
    expect(abandoned[0]?.severity).toBe('critical')
    expect(abandoned[0]?.details).toMatchObject({ missionId, amountCents: PENALTY_CENTS })

    // Hold acheteur toujours en place (créance + hold = double action humaine).
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('HELD')
  })
})
