import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * POST /api/stripe/issuing-authorization — autorisation JIT temps réel + GEL DES
 * FONDS (Sprint 9). Une mission gelée (DISPUTED / CANCELLED) garde un escrow HELD :
 * sans garde dédiée, la carte resterait approuvée (WITHIN_BUDGET). La garde bloque
 * l'achat AVANT le contrôle de budget et journalise un motif explicite.
 *
 * (A) IN_PROGRESS sous budget → approved:true, reason WITHIN_BUDGET ;
 * (B) DISPUTED → approved:false, reason MISSION_DISPUTED (escrow toujours HELD) ;
 * (C) CANCELLED → approved:false, reason MISSION_CANCELLED.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 */

const ISSUING_SECRET = 'whsec_test_issuing'
const BUDGET_CENTS = 40_000

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = ISSUING_SECRET
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('POST /api/stripe/issuing-authorization — gel des fonds JIT (Sprint 9)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  const stripe = new Stripe('sk_test_dummy')

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

    buyer = await prisma.user.create({ data: { email: 'buyer-jit@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-jit@test.waylo' } })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  // Mission + escrow HELD avec carte JIT liée. L'escrow reste HELD quel que soit
  // le statut mission (le gel ne touche jamais l'escrow — invariant Sprints 7-8).
  async function seed(status: 'IN_PROGRESS' | 'DISPUTED' | 'CANCELLED', cardId: string) {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status,
        targetProduct: 'Sneakers JIT',
        budgetCents: BUDGET_CENTS,
        commissionCents: 4_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_jit_${mission.id}`,
        stripeIssuingCardId: cardId,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission
  }

  function authorize(eventId: string, cardId: string, amountCents: number) {
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'issuing_authorization.request',
      data: {
        object: {
          id: `iauth_${eventId}`,
          object: 'issuing.authorization',
          pending_request: { amount: amountCents },
          card: { id: cardId },
        },
      },
    })
    return app.inject({
      method: 'POST',
      url: '/api/stripe/issuing-authorization',
      payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: ISSUING_SECRET }),
      },
    })
  }

  // Le log d'audit est écrit en fire-and-forget (réponse non bloquée) : on attend
  // sa matérialisation avant d'asserter le motif.
  async function waitForLog(eventId: string) {
    const stripeAuthorizationId = `iauth_${eventId}`
    for (let i = 0; i < 40; i++) {
      const log = await prisma.issuingAuthorizationLog.findUnique({ where: { stripeAuthorizationId } })
      if (log) return log
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`IssuingAuthorizationLog introuvable: ${stripeAuthorizationId}`)
  }

  it('(A) IN_PROGRESS sous budget → approved:true, reason WITHIN_BUDGET', async () => {
    await seed('IN_PROGRESS', 'ic_jit_inprogress')
    const res = await authorize('evt_jit_ok', 'ic_jit_inprogress', 30_000)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: true })

    const log = await waitForLog('evt_jit_ok')
    expect(log.decision).toBe('APPROVED')
    expect(log.reason).toBe('WITHIN_BUDGET')
  })

  it('(B) DISPUTED → approved:false, reason MISSION_DISPUTED (escrow encore HELD)', async () => {
    await seed('DISPUTED', 'ic_jit_disputed')
    const res = await authorize('evt_jit_disputed', 'ic_jit_disputed', 30_000)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: false })

    const log = await waitForLog('evt_jit_disputed')
    expect(log.decision).toBe('DECLINED')
    expect(log.reason).toBe('MISSION_DISPUTED')
  })

  it('(C) CANCELLED → approved:false, reason MISSION_CANCELLED', async () => {
    await seed('CANCELLED', 'ic_jit_cancelled')
    const res = await authorize('evt_jit_cancelled', 'ic_jit_cancelled', 30_000)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: false })

    const log = await waitForLog('evt_jit_cancelled')
    expect(log.decision).toBe('DECLINED')
    expect(log.reason).toBe('MISSION_CANCELLED')
  })
})
