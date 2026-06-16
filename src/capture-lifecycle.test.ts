import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from './generated/prisma'
import type { OpsAlert } from './alerts'

/**
 * Tests du cycle de vie capture (cf. timeline en tête de workers/reconciliation.ts) :
 * (A) capture réelle Stripe sans ligne CAPTURE → CAPTURE_WITHOUT_LEDGER, une fois ;
 * (B) deux refunds partiels additifs (cumuls 2000 puis 4000) → DEUX lignes REFUND
 *     de 2000 — le verrou sérialise SANS perdre d'écriture ;
 * (C) compte Connect manquant à la capture → CAPTURE journalisée, mission routée
 *     AWAITING_TRAVELER_ACCOUNT + alerte, réponse 200, pas de rejeu en boucle ;
 * (D) M tentatives → ABANDONED + UNE alerte, hors scope worker et requeue.
 */

const WEBHOOK_SECRET = 'whsec_test_async'
const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

const stripeSigner = new Stripe('sk_test_dummy')

async function signedInject(app: FastifyInstance, body: Record<string, unknown>) {
  const payload = JSON.stringify(body)
  return app.inject({
    method: 'POST',
    url: '/api/stripe/webhook',
    payload,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripeSigner.webhooks.generateTestHeaderString({
        payload,
        secret: WEBHOOK_SECRET,
      }),
    },
  })
}

describe('Cycle de vie capture — réconciliation, refunds additifs, routage, abandon', () => {
  let prisma: PrismaClient
  let buyer: User

  beforeAll(async () => {
    prisma = (await import('./db')).prisma

    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.issuingAuthorizationLog.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.user.deleteMany()

    buyer = await prisma.user.create({
      data: { email: 'buyer-lifecycle@test.waylo', kycStatus: 'VERIFIED' },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function seedMissionEscrow(opts: {
    pi: string
    idem: string
    travelerData?: { stripeAccountId: string | null; kycStatus: 'PENDING' | 'VERIFIED' }
    missionStatus?: 'IN_PROGRESS' | 'AWAITING_VALIDATION' | 'VALIDATED'
  }): Promise<{ missionId: string; escrowId: string }> {
    const traveler = opts.travelerData
      ? await prisma.user.create({
          data: {
            email: `traveler-${opts.idem}@test.waylo`,
            kycStatus: opts.travelerData.kycStatus,
            stripeAccountId: opts.travelerData.stripeAccountId,
          },
        })
      : null
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler?.id ?? null,
        status: opts.missionStatus ?? 'IN_PROGRESS',
        targetProduct: 'Article introuvable',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Kyoto',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    // T0 : pré-capture — capturedAmountCents 0 (défaut), ledger vide.
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: opts.pi,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: opts.idem,
      },
    })
    return { missionId: mission.id, escrowId: escrow.id }
  }

  it('(A) PaymentIntent capturé côté Stripe sans ligne CAPTURE → CAPTURE_WITHOUT_LEDGER, une fois', async () => {
    const { runReconciliation } = await import('./workers/reconciliation')
    const { escrowId } = await seedMissionEscrow({
      pi: 'pi_captured_no_ledger',
      idem: 'idem_lifecycle_a',
      travelerData: { stripeAccountId: 'acct_a', kycStatus: 'VERIFIED' },
    })

    // Fake Stripe : la capture a EU LIEU côté Stripe (rollback historique simulé).
    const fakeStripe = {
      transfers: { retrieve: async (): Promise<unknown> => ({}) },
      paymentIntents: {
        retrieve: async (): Promise<{ amount_received: number }> => ({
          amount_received: BUDGET_CENTS,
        }),
        cancel: async (id: string): Promise<{ id: string }> => ({ id }),
        capture: async (id: string): Promise<{ id: string }> => ({ id }),
      },
    }

    const collected: OpsAlert[] = []
    const alerts = await runReconciliation({
      prisma,
      stripe: fakeStripe,
      onAlert: a => collected.push(a),
    })

    const captureAlerts = alerts.filter(a => a.code === 'CAPTURE_WITHOUT_LEDGER')
    expect(captureAlerts).toHaveLength(1)
    expect(captureAlerts[0]?.details).toMatchObject({
      escrowId,
      stripePaymentIntentId: 'pi_captured_no_ledger',
    })
    expect(collected).toEqual(alerts)
    // Pas de faux positif inverse, ni d'invariant cassé (escrow pré-capture en DB).
    expect(alerts.filter(a => a.code === 'LEDGER_CAPTURE_NOT_CONFIRMED')).toHaveLength(0)
    expect(alerts.filter(a => a.code === 'LEDGER_INVARIANT_BROKEN')).toHaveLength(0)
  })

  it('(B) deux refunds partiels additifs sous verrou → DEUX lignes REFUND (2000 + 2000)', async () => {
    const { buildApp } = await import('./app')
    const { runReconciliation } = await import('./workers/reconciliation')
    const app = await buildApp()
    const { escrowId } = await seedMissionEscrow({
      pi: 'pi_two_partial_refunds',
      idem: 'idem_lifecycle_b',
      travelerData: { stripeAccountId: 'acct_b', kycStatus: 'VERIFIED' },
    })
    // Post-capture (T2 passée) : capturedAmountCents + ligne CAPTURE.
    await prisma.escrowTransaction.update({
      where: { id: escrowId },
      data: { capturedAmountCents: BUDGET_CENTS },
    })
    await prisma.ledgerEntry.create({
      data: { escrowId, type: 'CAPTURE', amountCents: BUDGET_CENTS },
    })

    const refundEvent = (eventId: string, cumulCents: number): Record<string, unknown> => ({
      id: eventId,
      object: 'event',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_two_partial_refunds',
          object: 'charge',
          payment_intent: 'pi_two_partial_refunds',
          amount_refunded: cumulCents, // CUMUL Stripe
          metadata: {},
        },
      },
    })

    // Refund 1 : cumul 2000. Refund 2 : cumul 4000 → delta 2000.
    const first = await signedInject(app, refundEvent('evt_refund_partial_1', 2_000))
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ handled: true, duplicate: false })
    const second = await signedInject(app, refundEvent('evt_refund_partial_2', 4_000))
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ handled: true, duplicate: false })

    // DEUX écritures distinctes de 2000 — sérialisées, aucune perdue, total 4000.
    const refunds = await prisma.ledgerEntry.findMany({
      where: { escrowId, type: 'REFUND' },
      orderBy: { createdAt: 'asc' },
    })
    expect(refunds.map(r => r.amountCents)).toEqual([2_000, 2_000])

    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('PARTIALLY_REFUNDED')

    // L'invariant STRICT (sans special-case PARTIALLY_REFUNDED) accepte ce cas
    // légitime : Σ(CAPTURE)==capturedAmountCents, Σ(sorties) ≤ Σ(CAPTURE).
    const alerts = await runReconciliation({ prisma, onAlert: () => {} })
    expect(alerts.filter(a => a.code === 'LEDGER_INVARIANT_BROKEN')).toHaveLength(0)
    await app.close()
  })

  it("(C) compte Connect manquant : capture journalisée, mission routée, alerte, 200 — pas de boucle", async () => {
    const { buildApp } = await import('./app')
    const collected: OpsAlert[] = []
    const app = await buildApp({ onAlert: a => collected.push(a) })

    const { missionId, escrowId } = await seedMissionEscrow({
      pi: 'pi_no_connect_account',
      idem: 'idem_lifecycle_c',
      travelerData: { stripeAccountId: null, kycStatus: 'VERIFIED' }, // pas de compte Connect
      missionStatus: 'AWAITING_VALIDATION',
    })

    const captureEvent = {
      id: 'evt_capture_no_account',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_no_connect_account',
          object: 'payment_intent',
          amount_received: BUDGET_CENTS,
        },
      },
    }

    // 1re livraison : 200, traité — PAS un 500 qui ferait rejouer 3 jours.
    const first = await signedInject(app, captureEvent)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ received: true, duplicate: false, handled: true })

    // La capture EST journalisée (point 2 : découplée de la précondition compte)…
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('HELD')
    expect(escrow.capturedAmountCents).toBe(BUDGET_CENTS)
    const ledger = await prisma.ledgerEntry.findMany({ where: { escrowId } })
    expect(ledger.map(l => l.type)).toEqual(['CAPTURE'])
    // …sans libération : zéro PAYOUT, zéro outbox.
    expect(await prisma.transferOutbox.count({ where: { escrowId } })).toBe(0)

    // Mission routée vers l'état d'intervention explicite + alerte émise.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe('AWAITING_TRAVELER_ACCOUNT')
    const accountAlerts = collected.filter(a => a.code === 'TRAVELER_ACCOUNT_MISSING')
    expect(accountAlerts).toHaveLength(1)
    expect(accountAlerts[0]?.severity).toBe('ops') // fonds bloqués, action ops — durable (NDJSON), sans pager critique
    expect(accountAlerts[0]?.details).toMatchObject({
      escrowId,
      missionId,
      reason: 'NO_CONNECT_ACCOUNT',
    })

    // Rejeu Stripe : doublon acquitté, AUCUN nouvel effet ni nouvelle alerte.
    const replay = await signedInject(app, captureEvent)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({ duplicate: true, handled: false })
    expect(await prisma.ledgerEntry.count({ where: { escrowId } })).toBe(1)
    expect(collected.filter(a => a.code === 'TRAVELER_ACCOUNT_MISSING')).toHaveLength(1)
    await app.close()
  })

  it('(E) webhook : une mission VALIDATED (T1 via /validate) est libérée → RELEASED', async () => {
    // Prouve le garde élargi du webhook : VALIDATED, comme AWAITING_VALIDATION,
    // converge vers RELEASED (escrow + mission), avec PAYOUT/COMMISSION/outbox.
    const { buildApp } = await import('./app')
    const app = await buildApp()
    const { missionId, escrowId } = await seedMissionEscrow({
      pi: 'pi_validated_release',
      idem: 'idem_lifecycle_e',
      travelerData: { stripeAccountId: 'acct_e', kycStatus: 'VERIFIED' },
      missionStatus: 'VALIDATED',
    })

    const res = await signedInject(app, {
      id: 'evt_capture_validated',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_validated_release', object: 'payment_intent', amount_received: BUDGET_CENTS },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ handled: true })

    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('RELEASED')
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe('RELEASED') // VALIDATED → RELEASED par le webhook
    const ledger = await prisma.ledgerEntry.findMany({ where: { escrowId } })
    expect(ledger.map(l => l.type).sort()).toEqual(['CAPTURE', 'COMMISSION', 'PAYOUT'])
    expect(await prisma.transferOutbox.count({ where: { escrowId } })).toBe(1)
    // Nettoyage : ne pas laisser d'outbox PENDING que le worker d'un autre test ramasserait.
    await prisma.transferOutbox.deleteMany({ where: { escrowId } })
    await app.close()
  })

  it('(D) M tentatives → ABANDONED, UNE alerte, plus de requeue possible', async () => {
    const { runTransferWorkerOnce } = await import('./workers/transfer-worker')
    const { requeueFailedTransfer } = await import('./workers/reconciliation')
    const MAX_ATTEMPTS = 5

    const { escrowId } = await seedMissionEscrow({
      pi: 'pi_abandoned_transfer',
      idem: 'idem_lifecycle_d',
      travelerData: { stripeAccountId: 'acct_closed', kycStatus: 'VERIFIED' },
    })
    const outbox = await prisma.transferOutbox.create({
      data: {
        escrowId,
        destinationAccountId: 'acct_closed',
        amountCents: BUDGET_CENTS - COMMISSION_CENTS,
        status: 'FAILED',
        attempts: MAX_ATTEMPTS - 1, // prochain échec = M-ième tentative
        lastError: 'account closed',
        idempotencyKey: `transfer_release_${escrowId}`,
      },
    })
    await prisma.$executeRaw`
      UPDATE "TransferOutbox" SET "updatedAt" = now() - interval '1 day' WHERE "id" = ${outbox.id}
    `

    const collected: OpsAlert[] = []
    const failingStripe = {
      transfers: {
        create: async (): Promise<{ id: string }> => {
          throw new Error('destination account closed')
        },
      },
    }

    const run = await runTransferWorkerOnce({
      prisma,
      stripe: failingStripe,
      maxAttempts: MAX_ATTEMPTS,
      onAlert: a => collected.push(a),
    })
    expect(run).toEqual({ settled: 0, failed: 0, abandoned: 1 })

    const after = await prisma.transferOutbox.findUniqueOrThrow({ where: { id: outbox.id } })
    expect(after.status).toBe('ABANDONED')
    expect(after.attempts).toBe(MAX_ATTEMPTS)
    expect(after.lastError).toBe('destination account closed')
    const abandonAlerts = collected.filter(a => a.code === 'TRANSFER_ABANDONED')
    expect(abandonAlerts).toHaveLength(1)
    expect(abandonAlerts[0]?.severity).toBe('critical') // « needs human » → canal critique

    // Terminal : le worker ne la re-sélectionne plus, AUCUNE nouvelle alerte.
    const again = await runTransferWorkerOnce({
      prisma,
      stripe: failingStripe,
      maxAttempts: MAX_ATTEMPTS,
      onAlert: a => collected.push(a),
    })
    expect(again).toEqual({ settled: 0, failed: 0, abandoned: 0 })
    expect(collected).toHaveLength(1)

    // Hors scope de la remédiation : requeue refuse un ABANDONED.
    expect(await requeueFailedTransfer(prisma, outbox.id)).toBe(false)
    expect(
      (await prisma.transferOutbox.findUniqueOrThrow({ where: { id: outbox.id } })).status,
    ).toBe('ABANDONED')
  })
})
