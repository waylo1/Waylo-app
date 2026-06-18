import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Matchmaking (brique 3) & début cycle voyageur (brique 5) :
 * - POST /:id/match : un voyageur prend une mission FUNDED → MATCHED ;
 *   l'acheteur ne peut pas se match lui-même ; course de deux voyageurs ;
 * - POST /:id/start-travel : le voyageur assigné passe MATCHED → IN_PROGRESS ;
 *   refusé pour l'acheteur / un tiers (404) et hors statut MATCHED (400).
 *
 * Prérequis : DATABASE_URL → base waylo_test (cf. webhook.idempotence.test.ts).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500

describe('Matchmaking & cycle voyageur — match / start-travel', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let travelerA: User
  let travelerB: User
  let buyerToken: string
  let travelerAToken: string
  let travelerBToken: string

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

    buyer = await prisma.user.create({ data: { email: 'buyer-match@test.waylo' } })
    // Carte de garantie requise pour /match (hardening voyageur, Sprint 13).
    travelerA = await prisma.user.create({
      data: { email: 'travelerA-match@test.waylo', stripePaymentMethodId: 'pm_match_traveler_a' },
    })
    travelerB = await prisma.user.create({
      data: { email: 'travelerB-match@test.waylo', stripePaymentMethodId: 'pm_match_traveler_b' },
    })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerAToken = app.jwt.sign({ sub: travelerA.id })
    travelerBToken = app.jwt.sign({ sub: travelerB.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const match = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/missions/${id}/match`, headers })
  const startTravel = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/missions/${id}/start-travel`, headers })

  const seedMission = (overrides: {
    status?: 'CREATED' | 'FUNDED' | 'MATCHED' | 'IN_PROGRESS'
    travelerId?: string
  } = {}) =>
    prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: overrides.travelerId ?? null,
        status: overrides.status ?? 'FUNDED',
        targetProduct: 'Article à convoyer',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

  // ── match ────────────────────────────────────────────────────────────────
  it('match réussi : voyageur → 200, travelerId inscrit, statut MATCHED', async () => {
    const mission = await seedMission()
    const res = await match(mission.id, bearer(travelerAToken))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      id: mission.id,
      travelerId: travelerA.id,
      status: 'MATCHED',
    })
  })

  it("l'acheteur ne peut pas se match lui-même → 400", async () => {
    const mission = await seedMission()
    const res = await match(mission.id, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'CANNOT_MATCH_OWN_MISSION' })
    // Mission intacte.
    const after = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(after.status).toBe('FUNDED')
    expect(after.travelerId).toBeNull()
  })

  it('mission inexistante → 404 ; mission non-FUNDED (CREATED) → 400', async () => {
    const missing = await match('cmmissionintrouvable0', bearer(travelerAToken))
    expect(missing.statusCode).toBe(404)

    const created = await seedMission({ status: 'CREATED' })
    const res = await match(created.id, bearer(travelerAToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_MATCHABLE' })
  })

  it('course de deux voyageurs : un seul gagne, le second prend 400 MISSION_ALREADY_MATCHED', async () => {
    const mission = await seedMission()
    const [resA, resB] = await Promise.all([
      match(mission.id, bearer(travelerAToken)),
      match(mission.id, bearer(travelerBToken)),
    ])

    const statuses = [resA.statusCode, resB.statusCode].sort()
    expect(statuses).toEqual([200, 400])
    const loser = resA.statusCode === 400 ? resA : resB
    expect(loser.json()).toEqual({ error: 'MISSION_ALREADY_MATCHED' })

    // La mission est MATCHED avec EXACTEMENT un des deux voyageurs.
    const after = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(after.status).toBe('MATCHED')
    expect([travelerA.id, travelerB.id]).toContain(after.travelerId)
  })

  it('match non authentifié → 401', async () => {
    const mission = await seedMission()
    const res = await match(mission.id)
    expect(res.statusCode).toBe(401)
  })

  // ── start-travel ───────────────────────────────────────────────────────────
  it('start-travel : le voyageur assigné → 200, statut IN_PROGRESS', async () => {
    const mission = await seedMission({ status: 'MATCHED', travelerId: travelerA.id })
    const res = await startTravel(mission.id, bearer(travelerAToken))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: mission.id, status: 'IN_PROGRESS' })
  })

  it("start-travel refusé pour l'acheteur (404) et un tiers (404)", async () => {
    const mission = await seedMission({ status: 'MATCHED', travelerId: travelerA.id })
    const byBuyer = await startTravel(mission.id, bearer(buyerToken))
    expect(byBuyer.statusCode).toBe(404)
    expect(byBuyer.json()).toEqual({ error: 'MISSION_NOT_FOUND' })

    const byStranger = await startTravel(mission.id, bearer(travelerBToken))
    expect(byStranger.statusCode).toBe(404)

    // Mission intacte (toujours MATCHED).
    const after = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(after.status).toBe('MATCHED')
  })

  it('start-travel hors statut MATCHED (déjà IN_PROGRESS) → 400 MISSION_NOT_MATCHED', async () => {
    const mission = await seedMission({ status: 'MATCHED', travelerId: travelerA.id })
    const first = await startTravel(mission.id, bearer(travelerAToken))
    expect(first.statusCode).toBe(200)
    const second = await startTravel(mission.id, bearer(travelerAToken))
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'MISSION_NOT_MATCHED' })
  })

  it('start-travel non authentifié → 401', async () => {
    const mission = await seedMission({ status: 'MATCHED', travelerId: travelerA.id })
    const res = await startTravel(mission.id)
    expect(res.statusCode).toBe(401)
  })
})
