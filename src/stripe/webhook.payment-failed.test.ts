import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '../generated/prisma'

/**
 * payment_intent.payment_failed : l'escrow HELD (jamais capturé) passe à CANCELLED
 * et la mission à CANCELLED, sans aucune écriture de ledger. Un second échec sur le
 * même escrow (event.id distinct) ressort en acquit idempotent (handled:false).
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 */

const WEBHOOK_SECRET = 'whsec_test_async'
const PI_ID = 'pi_waylo_failed_test'
const EVENT_ID = 'evt_waylo_failed_test'
const BUDGET_CENTS = 8_000
const COMMISSION_CENTS = 1_000

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('POST /api/stripe/webhook — payment_intent.payment_failed', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let escrowId: string
  let missionId: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()

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

    const buyer = await prisma.user.create({
      data: { email: 'buyer-failed@test.waylo', kycStatus: 'VERIFIED' },
    })
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'FUNDED',
        targetProduct: 'Article financé puis paiement échoué',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    missionId = mission.id
    // Timeline T0 : escrow HELD, jamais capturé (capturedAmountCents 0, ledger vide).
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: PI_ID,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: 'idem_waylo_failed_1',
      },
    })
    escrowId = escrow.id
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const inject = (eventId: string) => {
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'payment_intent.payment_failed',
      data: { object: { id: PI_ID, object: 'payment_intent', amount_received: 0 } },
    })
    const stripe = new Stripe('sk_test_dummy')
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

  it('passe l’escrow HELD → CANCELLED et la mission → CANCELLED, sans ledger', async () => {
    const res = await inject(EVENT_ID)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ received: true, duplicate: false, handled: true })

    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('CANCELLED')
    expect(escrow.capturedAmountCents).toBe(0)

    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe('CANCELLED')

    // Aucun mouvement comptable : un paiement échoué ne capture rien.
    expect(await prisma.ledgerEntry.count({ where: { escrowId } })).toBe(0)
  })

  it('second échec distinct (event.id différent) : acquit idempotent, aucun changement', async () => {
    // event.id distinct → passe la barrière ProcessedStripeEvent ; l'escrow est déjà
    // CANCELLED → updateMany count 0 → NO_EFFECT (handled:false), pas d'abort.
    const res = await inject('evt_waylo_failed_replay')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ received: true, duplicate: false, handled: false })

    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('CANCELLED')
  })
})
