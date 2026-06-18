import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import type { OpsAlert } from '../alerts'

/**
 * Litige acheteur — POST /api/missions/:id/dispute.
 * L'acheteur ouvre un litige sur un colis déposé → DEPOSITED → DISPUTED (gel).
 * DISPUTED n'est ciblé par aucun worker de timeout : exécution auto bloquée.
 *
 * (A) acheteur + DEPOSITED + motif → 200 DISPUTED, motif + disputedAt scellés,
 *     alerte critique MISSION_DISPUTED_BY_BUYER émise ;
 * (B) acheteur + DEPOSITED sans motif (optionnel) → 200, disputeReason null ;
 * (C) état non-DEPOSITED (VALIDATED, RELEASED) → 400 INVALID_MISSION_STATE, aucune alerte ;
 * (D) IDOR : voyageur → 404, tiers → 404, non authentifié → 401, aucune alerte/écriture ;
 * (E) double litige (2e appel après DISPUTED) → 400 INVALID_MISSION_STATE ;
 * (F) motif trop long (> 2000) → 400 INVALID_INPUT (Ajv).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('Litige acheteur — dispute', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let stranger: User
  let buyerToken: string
  let travelerToken: string
  let strangerToken: string
  const emitted: OpsAlert[] = []

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({ id: `pi_dp_${params.metadata['missionId']}`, client_secret: 'secret' }),
      capture: async (id) => ({ id }),
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe, onAlert: a => emitted.push(a) })

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

    buyer = await prisma.user.create({ data: { email: 'buyer-dp@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-dp@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-dp@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    strangerToken = app.jwt.sign({ sub: stranger.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    emitted.length = 0
    await prisma.escrowTransaction.deleteMany()
    await prisma.mission.deleteMany()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const dispute = (
    id: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = bearer(buyerToken),
  ) => app.inject({ method: 'POST', url: `/api/missions/${id}/dispute`, headers, payload: body })

  async function seedMission(status: string) {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: status as never,
        targetProduct: 'Colis litige',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Bordeaux',
        dropoffReceiptUrl: 'https://proofs.waylo.app/d.pdf',
        dropoffAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  it('(A) acheteur + DEPOSITED + motif → 200 DISPUTED, motif/disputedAt scellés, alerte critique', async () => {
    const mission = await seedMission('DEPOSITED')
    const res = await dispute(mission.id, { disputeReason: 'Colis endommagé à réception' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('DISPUTED')
    expect(body.disputeReason).toBe('Colis endommagé à réception')
    expect(body.disputedAt).toBeTruthy()

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DISPUTED')

    const alert = emitted.find(a => a.code === 'MISSION_DISPUTED_BY_BUYER')
    expect(alert).toBeTruthy()
    expect(alert?.severity).toBe('critical')
    expect(alert?.details.missionId).toBe(mission.id)
  })

  it('(B) acheteur + DEPOSITED sans motif → 200 DISPUTED, disputeReason null', async () => {
    const mission = await seedMission('DEPOSITED')
    const res = await dispute(mission.id, {})

    expect(res.statusCode).toBe(200)
    expect(res.json().disputeReason).toBeNull()
    expect(emitted.some(a => a.code === 'MISSION_DISPUTED_BY_BUYER')).toBe(true)
  })

  it('(C) état non-DEPOSITED (VALIDATED puis RELEASED) → 400 INVALID_MISSION_STATE, aucune alerte', async () => {
    for (const status of ['VALIDATED', 'RELEASED']) {
      emitted.length = 0
      const mission = await seedMission(status)
      const res = await dispute(mission.id, { disputeReason: 'trop tard' })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'INVALID_MISSION_STATE' })
      expect(emitted).toHaveLength(0)

      const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      expect(db.status).toBe(status) // inchangé
    }
  })

  it('(D) IDOR : voyageur → 404, tiers → 404, non authentifié → 401, aucune alerte', async () => {
    const mission = await seedMission('DEPOSITED')

    expect((await dispute(mission.id, {}, bearer(travelerToken))).statusCode).toBe(404)
    expect((await dispute(mission.id, {}, bearer(strangerToken))).statusCode).toBe(404)
    expect((await dispute(mission.id, {}, {})).statusCode).toBe(401)
    expect(emitted).toHaveLength(0)

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DEPOSITED') // aucune écriture
  })

  it('(E) double litige → 400 INVALID_MISSION_STATE (2e appel)', async () => {
    const mission = await seedMission('DEPOSITED')

    const first = await dispute(mission.id, { disputeReason: 'motif' })
    expect(first.statusCode).toBe(200)

    const second = await dispute(mission.id, { disputeReason: 'encore' })
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'INVALID_MISSION_STATE' })
  })

  it('(F) motif > 2000 caractères → 400 INVALID_INPUT (Ajv)', async () => {
    const mission = await seedMission('DEPOSITED')
    const res = await dispute(mission.id, { disputeReason: 'x'.repeat(2001) })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
    expect(emitted).toHaveLength(0)
  })
})
