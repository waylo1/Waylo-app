import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * POST /:id/reviews — notation mutuelle post-clôture (Sprint 10).
 *
 * Seuls les participants (buyer / traveler) peuvent noter une mission clôturée
 * (RELEASED ou CANCELLED). targetId est dérivé automatiquement. Doublon bloqué
 * par @@unique(missionId, authorId).
 *
 * (A) buyer → traveler sur mission RELEASED : 201, Review persistée ;
 * (B) doublon : 2e appel → 409 REVIEW_ALREADY_SUBMITTED ;
 * (C) mission non terminale (IN_PROGRESS) → 400 MISSION_NOT_TERMINAL ;
 * (D) utilisateur externe (ni buyer ni traveler) → 404 MISSION_NOT_FOUND.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('POST /api/missions/:id/reviews — notation post-clôture (Sprint 10)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let outsider: User
  let buyerToken: string
  let travelerToken: string
  let outsiderToken: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()

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

    buyer = await prisma.user.create({ data: { email: 'buyer-review@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-review@test.waylo' } })
    outsider = await prisma.user.create({ data: { email: 'outsider-review@test.waylo' } })

    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    outsiderToken = app.jwt.sign({ sub: outsider.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  const postReview = (
    missionId: string,
    token: string,
    body: { rating: number; comment?: string },
  ) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/reviews`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })

  async function seedMission(status: 'RELEASED' | 'CANCELLED' | 'IN_PROGRESS') {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status,
        targetProduct: 'Article test review',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Paris',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  it('(A) buyer → traveler sur mission RELEASED : 201, Review persistée', async () => {
    const mission = await seedMission('RELEASED')
    const res = await postReview(mission.id, buyerToken, { rating: 5, comment: 'Parfait !' })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.missionId).toBe(mission.id)
    expect(body.authorId).toBe(buyer.id)
    expect(body.targetId).toBe(traveler.id)
    expect(body.rating).toBe(5)
    expect(body.comment).toBe('Parfait !')

    // Vérification en base.
    const db = await prisma.review.findUnique({
      where: { missionId_authorId: { missionId: mission.id, authorId: buyer.id } },
    })
    expect(db).not.toBeNull()
    expect(db!.targetId).toBe(traveler.id)
  })

  it('(B) doublon : 2e notation sur la même mission → 409 REVIEW_ALREADY_SUBMITTED', async () => {
    const mission = await seedMission('RELEASED')
    // 1er appel OK.
    expect((await postReview(mission.id, buyerToken, { rating: 4 })).statusCode).toBe(201)
    // 2e appel : contrainte @@unique violée.
    const res = await postReview(mission.id, buyerToken, { rating: 3 })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'REVIEW_ALREADY_SUBMITTED' })
  })

  it('(C) mission non terminale (IN_PROGRESS) → 400 MISSION_NOT_TERMINAL', async () => {
    const mission = await seedMission('IN_PROGRESS')
    const res = await postReview(mission.id, buyerToken, { rating: 3 })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_TERMINAL' })
  })

  it('(D) utilisateur externe → 404 MISSION_NOT_FOUND (invariant IDOR)', async () => {
    const mission = await seedMission('RELEASED')
    const res = await postReview(mission.id, outsiderToken, { rating: 1 })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
  })
})
