import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Autorisation JIT & dimensionnement « Drive » 120% (Sprint 17) —
 * POST /api/stripe/issuing-authorization.
 *
 * Quand l'acheteur a pré-autorisé la substitution (`Mission.substitutionAuthorized`),
 * le séquestre + le Spending Control de la carte JIT sont dimensionnés à 120% du
 * budget au financement ; la garde JIT autorise donc en temps réel jusqu'à
 * `Math.floor(budget * 1.20)` (centimes Int strict). Sans pré-autorisation, le
 * plafond reste le budget figé.
 *
 * (A) substitution autorisée + 115% du budget → approved:true, WITHIN_BUDGET ;
 * (B) substitution autorisée + 120% pile (borne incluse) → approved:true ;
 * (C) substitution autorisée + 125% du budget → approved:false, OVER_BUDGET ;
 * (D) substitution NON autorisée + 115% → approved:false, OVER_BUDGET (plafond = budget).
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 * (Fichier placé dans src/stripe/ — emplacement réel de la route JIT ; le dossier
 * src/webhooks/ n'existe pas dans ce dépôt.)
 */

const ISSUING_SECRET = 'whsec_test_issuing'
const BUDGET_CENTS = 40_000
const CAP_CENTS = Math.floor((BUDGET_CENTS * 12) / 10) // 48_000 (120%, strict)

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = ISSUING_SECRET
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('JIT substitution 120% — POST /api/stripe/issuing-authorization (Sprint 17)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  const stripe = new Stripe('sk_test_dummy')

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()

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

    buyer = await prisma.user.create({ data: { email: 'buyer-sub-jit@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-sub-jit@test.waylo' } })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  /**
   * Mission IN_PROGRESS + escrow HELD avec carte JIT liée. Le `spendingLimitCents`
   * reflète le financement : 120% du budget si substitution pré-autorisée (miroir de
   * /intent), sinon le budget figé.
   */
  async function seed(substitutionAuthorized: boolean, cardId: string) {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'IN_PROGRESS',
        targetProduct: 'Sneakers JIT substituables',
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
        stripePaymentIntentId: `pi_subjit_${mission.id}`,
        stripeIssuingCardId: cardId,
        status: 'HELD',
        spendingLimitCents: substitutionAuthorized ? CAP_CENTS : BUDGET_CENTS,
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

  // Audit écrit en fire-and-forget : on attend sa matérialisation avant d'asserter.
  async function waitForLog(eventId: string) {
    const stripeAuthorizationId = `iauth_${eventId}`
    for (let i = 0; i < 40; i++) {
      const log = await prisma.issuingAuthorizationLog.findUnique({ where: { stripeAuthorizationId } })
      if (log) return log
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error(`IssuingAuthorizationLog introuvable: ${stripeAuthorizationId}`)
  }

  it('(A) substitution autorisée + 115% du budget → approved:true, WITHIN_BUDGET', async () => {
    await seed(true, 'ic_subjit_115')
    const res = await authorize('evt_subjit_115', 'ic_subjit_115', 46_000) // 115% de 40 000

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: true })

    const log = await waitForLog('evt_subjit_115')
    expect(log.decision).toBe('APPROVED')
    expect(log.reason).toBe('WITHIN_BUDGET')
  })

  it('(B) substitution autorisée + 120% pile → approved:true (borne incluse)', async () => {
    await seed(true, 'ic_subjit_120')
    const res = await authorize('evt_subjit_120', 'ic_subjit_120', CAP_CENTS) // 48 000 = 120%

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: true })

    const log = await waitForLog('evt_subjit_120')
    expect(log.reason).toBe('WITHIN_BUDGET')
  })

  it('(C) substitution autorisée + 125% du budget → approved:false, OVER_BUDGET', async () => {
    await seed(true, 'ic_subjit_125')
    const res = await authorize('evt_subjit_125', 'ic_subjit_125', 50_000) // 125% > plafond 48 000

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: false })

    const log = await waitForLog('evt_subjit_125')
    expect(log.decision).toBe('DECLINED')
    expect(log.reason).toBe('OVER_BUDGET')
  })

  it('(D) substitution NON autorisée + 115% → approved:false, OVER_BUDGET (plafond = budget)', async () => {
    await seed(false, 'ic_subjit_noauth')
    const res = await authorize('evt_subjit_noauth', 'ic_subjit_noauth', 46_000) // > budget 40 000

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ approved: false })

    const log = await waitForLog('evt_subjit_noauth')
    expect(log.decision).toBe('DECLINED')
    expect(log.reason).toBe('OVER_BUDGET')
  })
})
