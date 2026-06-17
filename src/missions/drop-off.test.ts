import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * POST /:id/drop-off — dépôt logistique asynchrone (Sprint 11).
 *
 * Réservé au voyageur assigné. Transition atomique IN_PROGRESS → AWAITING_VALIDATION.
 * `droppedAt` scellé serveur ; `dropOffAccessCode` optionnel.
 *
 * (A) Succès locker avec access code : 200, champs persistés, statut AWAITING_VALIDATION ;
 * (B) Appelant = buyer → 404 (invariant IDOR, identique à un tiers) ;
 * (C) Statut invalide (AWAITING_VALIDATION déjà posé) → 400 MISSION_NOT_IN_PROGRESS.
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

describe('POST /api/missions/:id/drop-off — dépôt logistique (Sprint 11)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let buyerToken: string
  let travelerToken: string

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

    buyer = await prisma.user.create({ data: { email: 'buyer-dropoff@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-dropoff@test.waylo' } })

    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  async function seedMission(status: 'IN_PROGRESS' | 'AWAITING_VALIDATION') {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status,
        targetProduct: 'Sneakers Sprint 11',
        budgetCents: 35_000,
        commissionCents: 3_500,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  const dropOff = (missionId: string, token: string, body: object) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/drop-off`,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })

  it('(A) dépôt locker avec access code : 200, champs persistés, statut AWAITING_VALIDATION', async () => {
    const mission = await seedMission('IN_PROGRESS')
    const res = await dropOff(mission.id, travelerToken, {
      dropOffType: 'LOCKER',
      dropOffCarrier: 'InPost',
      dropOffTrackingId: 'LP123456789PL',
      dropOffAccessCode: '4892',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('AWAITING_VALIDATION')
    expect(body.dropOffType).toBe('LOCKER')
    expect(body.dropOffCarrier).toBe('InPost')
    expect(body.dropOffTrackingId).toBe('LP123456789PL')
    expect(body.droppedAt).toBeTruthy()

    // Vérification en base.
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('AWAITING_VALIDATION')
    expect(db.dropOffType).toBe('LOCKER')
    expect(db.dropOffCarrier).toBe('InPost')
    expect(db.dropOffTrackingId).toBe('LP123456789PL')
    expect(db.dropOffAccessCode).toBe('4892')
    expect(db.droppedAt).toBeInstanceOf(Date)
  })

  it('(B) appelant = buyer → 404 MISSION_NOT_FOUND (invariant IDOR)', async () => {
    const mission = await seedMission('IN_PROGRESS')
    const res = await dropOff(mission.id, buyerToken, {
      dropOffType: 'RELAY',
      dropOffCarrier: 'Mondial Relay',
      dropOffTrackingId: 'MR987654321FR',
    })

    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })

    // Mission intacte : aucune mutation.
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('IN_PROGRESS')
  })

  it('(C) statut invalide (déjà AWAITING_VALIDATION) → 400 MISSION_NOT_IN_PROGRESS', async () => {
    const mission = await seedMission('AWAITING_VALIDATION')
    const res = await dropOff(mission.id, travelerToken, {
      dropOffType: 'POSTAL',
      dropOffCarrier: 'La Poste',
      dropOffTrackingId: '1Z999AA10123456784',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_IN_PROGRESS' })
  })
})
