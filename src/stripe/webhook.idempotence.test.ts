import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '../generated/prisma'

/**
 * Rejoue DEUX FOIS le même payment_intent.succeeded (même event.id, signature
 * valide) et prouve qu'un seul PAYOUT est écrit — l'idempotence repose sur
 * ProcessedStripeEvent + effet métier dans la même transaction.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 * Schéma appliqué par migrations versionnées (globalSetup → prisma migrate deploy).
 */

const WEBHOOK_SECRET = 'whsec_test_async'
const PI_ID = 'pi_waylo_idem_test'
const EVENT_ID = 'evt_waylo_idem_test'
const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500

// Garde-fou : ne jamais exécuter ce test contre la base FlipSync/Waylo de dev.
if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'

describe('POST /api/stripe/webhook — idempotence payment_intent.succeeded', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let escrowId: string

  beforeAll(async () => {
    // Imports dynamiques : les env vars ci-dessus doivent être posées avant
    // l'instanciation du PrismaClient et la lecture des secrets Stripe.
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()

    // Base de test dédiée : purge intégrale dans l'ordre des FK.
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
      data: { role: 'BUYER', email: 'buyer@test.waylo', kycStatus: 'VERIFIED' },
    })
    const traveler = await prisma.user.create({
      data: {
        role: 'TRAVELER',
        email: 'traveler@test.waylo',
        kycStatus: 'VERIFIED',
        stripeAccountId: 'acct_test_traveler', // requis : la libération crée l'intention de versement
      },
    })
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'AWAITING_VALIDATION',
        targetProduct: 'Sac à main introuvable en France',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    // Timeline T0 : escrow créé AVANT capture — capturedAmountCents 0, ledger vide.
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: PI_ID,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: 'idem_waylo_test_1',
      },
    })
    escrowId = escrow.id
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it("n'écrit qu'un seul PAYOUT quand le même event est livré deux fois", async () => {
    const payload = JSON.stringify({
      id: EVENT_ID,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: { id: PI_ID, object: 'payment_intent', amount_received: BUDGET_CENTS },
      },
    })
    const stripe = new Stripe('sk_test_dummy')
    const inject = () =>
      app.inject({
        method: 'POST',
        url: '/api/stripe/webhook',
        payload,
        headers: {
          'content-type': 'application/json',
          // Signature recalculée à chaque livraison, comme le fait Stripe sur un retry.
          'stripe-signature': stripe.webhooks.generateTestHeaderString({
            payload,
            secret: WEBHOOK_SECRET,
          }),
        },
      })

    // 1re livraison : effet appliqué.
    const first = await inject()
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ received: true, duplicate: false, handled: true })

    // 2e livraison (rejeu Stripe) : 200 sans effet.
    const second = await inject()
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ received: true, duplicate: true, handled: false })

    // UN SEUL PAYOUT, du bon montant.
    const payouts = await prisma.ledgerEntry.findMany({
      where: { escrowId, type: 'PAYOUT' },
    })
    expect(payouts).toHaveLength(1)
    expect(payouts[0]?.amountCents).toBe(BUDGET_CENTS - COMMISSION_CENTS)

    // Invariant : Σ(PAYOUT + COMMISSION + REFUND) == Σ(CAPTURE).
    const sums = await prisma.ledgerEntry.groupBy({
      by: ['type'],
      where: { escrowId },
      _sum: { amountCents: true },
    })
    const sumOf = (type: string) =>
      sums.find(s => s.type === type)?._sum.amountCents ?? 0
    expect(sumOf('PAYOUT') + sumOf('COMMISSION') + sumOf('REFUND')).toBe(sumOf('CAPTURE'))
    expect(sumOf('CAPTURE')).toBe(BUDGET_CENTS)

    // L'escrow est RELEASED, capturedAmountCents peuplé À la capture,
    // et l'event n'est enregistré qu'une fois.
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('RELEASED')
    expect(escrow.capturedAmountCents).toBe(BUDGET_CENTS)
    expect(
      await prisma.processedStripeEvent.count({ where: { stripeEventId: EVENT_ID } }),
    ).toBe(1)

    // L'intention de versement a committé avec le PAYOUT — une seule, PENDING,
    // aucun appel Stripe n'a eu lieu (le worker est le seul chemin d'exécution).
    const outbox = await prisma.transferOutbox.findMany({ where: { escrowId } })
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({
      status: 'PENDING',
      amountCents: BUDGET_CENTS - COMMISSION_CENTS,
      destinationAccountId: 'acct_test_traveler',
      stripeTransferId: null,
    })
  })

  it('ne sur-rembourse pas : deux events refund DISTINCTS en concurrence sur le même escrow', async () => {
    // Deux event.id différents passent la barrière d'idempotence — seul le
    // verrou FOR UPDATE sérialise le calcul du delta de remboursement.
    const PI_REFUND = 'pi_waylo_refund_test'
    const REFUNDED_CENTS = 4_000

    const buyer = await prisma.user.create({
      data: { role: 'BUYER', email: 'buyer-refund@test.waylo', kycStatus: 'VERIFIED' },
    })
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'IN_PROGRESS',
        targetProduct: 'Montre édition limitée',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Séoul',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    // Timeline T2 déjà passée : escrow post-capture (capturedAmountCents +
    // ligne CAPTURE) — précondition d'un charge.refunded légitime.
    const refundEscrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: PI_REFUND,
        capturedAmountCents: BUDGET_CENTS,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: 'idem_waylo_test_2',
      },
    })
    await prisma.ledgerEntry.create({
      data: { escrowId: refundEscrow.id, type: 'CAPTURE', amountCents: BUDGET_CENTS },
    })

    const stripe = new Stripe('sk_test_dummy')
    const injectRefund = (eventId: string) => {
      const payload = JSON.stringify({
        id: eventId,
        object: 'event',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_waylo_refund_test',
            object: 'charge',
            payment_intent: PI_REFUND,
            amount_refunded: REFUNDED_CENTS, // cumul identique : même refund, double notification
            metadata: {},
          },
        },
      })
      return app.inject({
        method: 'POST',
        url: '/api/stripe/webhook',
        payload,
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripe.webhooks.generateTestHeaderString({
            payload,
            secret: WEBHOOK_SECRET,
          }),
        },
      })
    }

    const [first, second] = await Promise.all([
      injectRefund('evt_waylo_refund_a'),
      injectRefund('evt_waylo_refund_b'),
    ])
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    // UNE seule ligne REFUND : la transaction arrivée seconde a attendu le
    // verrou, relu Σ(REFUND)=4000 → delta 0 → aucun write.
    const refunds = await prisma.ledgerEntry.findMany({
      where: { escrowId: refundEscrow.id, type: 'REFUND' },
    })
    expect(refunds).toHaveLength(1)
    expect(refunds[0]?.amountCents).toBe(REFUNDED_CENTS)

    const after = await prisma.escrowTransaction.findUniqueOrThrow({
      where: { id: refundEscrow.id },
    })
    expect(after.status).toBe('PARTIALLY_REFUNDED')
  })
})
