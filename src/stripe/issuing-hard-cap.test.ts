import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * Hard Cap 150% à l'autorisation JIT (audit robustesse) —
 * POST /api/stripe/issuing-authorization.
 *
 * Backstop absolu indépendant du plafond opérationnel 120% : aucune autorisation
 * au-delà de 150% du budget, même en substitution pré-autorisée. Refus fail-safe,
 * motif `HARD_CAP_EXCEEDED` (distinct de `OVER_BUDGET` du plafond 120%).
 *
 *   BUDGET 40 000 → plafond 120% = 48 000 → hard cap 150% = 60 000.
 *
 * (A) substitution + 160% (64 000 > hard cap) → DECLINED, HARD_CAP_EXCEEDED ;
 * (B) substitution + 150% pile (60 000, hard cap non dépassé) → DECLINED, OVER_BUDGET ;
 * (C) NON-substitution + 160% → DECLINED, HARD_CAP_EXCEEDED (backstop universel).
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test.
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

describe('JIT Hard Cap 150% — POST /api/stripe/issuing-authorization', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  const stripe = new Stripe('sk_test_dummy')

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-hardcap-jit@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-hardcap-jit@test.waylo' } })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  async function seed(substitutionAuthorized: boolean, cardId: string) {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'IN_PROGRESS',
        targetProduct: 'Article hard-cap',
        budgetCents: BUDGET_CENTS,
        commissionCents: 4_000,
        destination: 'Tokyo',
        substitutionAuthorized,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_hc_${mission.id}`,
        stripeIssuingCardId: cardId,
        status: 'HELD',
        spendingLimitCents: substitutionAuthorized
          ? Math.floor((BUDGET_CENTS * 12) / 10)
          : BUDGET_CENTS,
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

  async function waitForLog(eventId: string) {
    const stripeAuthorizationId = `iauth_${eventId}`
    for (let i = 0; i < 40; i++) {
      const log = await prisma.issuingAuthorizationLog.findUnique({ where: { stripeAuthorizationId } })
      if (log) return log
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`IssuingAuthorizationLog introuvable: ${stripeAuthorizationId}`)
  }

  it('(A) substitution + 160% (> hard cap 60 000) → DECLINED, HARD_CAP_EXCEEDED', async () => {
    await seed(true, 'ic_hc_160')
    const res = await authorize('evt_hc_160', 'ic_hc_160', 64_000) // 160% de 40 000

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: false })

    const log = await waitForLog('evt_hc_160')
    expect(log.decision).toBe('DECLINED')
    expect(log.reason).toBe('HARD_CAP_EXCEEDED')
  })

  it('(B) substitution + 150% pile (hard cap NON dépassé) → DECLINED, OVER_BUDGET', async () => {
    await seed(true, 'ic_hc_150')
    const res = await authorize('evt_hc_150', 'ic_hc_150', 60_000) // = hard cap, > plafond 48 000

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: false })

    const log = await waitForLog('evt_hc_150')
    expect(log.reason).toBe('OVER_BUDGET') // le backstop ne mord pas la borne incluse
  })

  it('(C) NON-substitution + 160% → DECLINED, HARD_CAP_EXCEEDED (backstop universel)', async () => {
    await seed(false, 'ic_hc_noauth')
    const res = await authorize('evt_hc_noauth', 'ic_hc_noauth', 64_000)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: false })

    const log = await waitForLog('evt_hc_noauth')
    expect(log.reason).toBe('HARD_CAP_EXCEEDED')
  })
})
