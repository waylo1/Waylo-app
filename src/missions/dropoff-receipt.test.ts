import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission.route'
import { hashQrCode } from './qr-proof'

/**
 * Module Dépôt Voyageur — POST /api/missions/:id/dropoff-receipt.
 * Le voyageur assigné enregistre le dépôt du colis (preuve + tracking optionnel).
 * Transition conditionnelle {MATCHED | VALIDATED} → DEPOSITED.
 *
 * (A) MATCHED + tracking → 200 DEPOSITED, métadonnées + dropoffAt scellés serveur ;
 * (B) VALIDATED (post-douane) sans tracking (champ optionnel) → 200, tracking null ;
 * (C) état invalide (IN_PROGRESS) → 400 INVALID_MISSION_STATE ;
 * (D) dropoffReceiptUrl manquant → 400 INVALID_INPUT (Ajv) ;
 * (E) URL non http(s) → 400 INVALID_INPUT (anti-XSS stocké) ;
 * (F) IDOR : acheteur → 404, tiers → 404, non authentifié → 401 (jamais 403) ;
 * (G) double dépôt (2e appel après DEPOSITED) → 400 INVALID_MISSION_STATE (anti-TOCTOU).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('Dépôt voyageur — POST /:id/dropoff-receipt', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let stranger: User
  let travelerToken: string
  let buyerToken: string
  let strangerToken: string

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({ id: `pi_do_${params.metadata['missionId']}`, client_secret: 'secret' }),
      capture: async (id) => ({ id }),
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })

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

    buyer = await prisma.user.create({ data: { email: 'buyer-do@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-do@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-do@test.waylo' } })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    strangerToken = app.jwt.sign({ sub: stranger.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const dropoff = (
    id: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = bearer(travelerToken),
  ) => app.inject({ method: 'POST', url: `/api/missions/${id}/dropoff-receipt`, headers, payload: body })

  async function seedMission(status: string) {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: status as never,
        targetProduct: 'Colis test dépôt',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Paris',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  const validBody = {
    dropoffReceiptUrl: 'https://proofs.waylo.app/dropoff.pdf',
    dropoffTrackingNumber: 'TRK-123456',
  }

  it('(A) MATCHED + tracking → 200 DEPOSITED, métadonnées + dropoffAt scellés', async () => {
    const mission = await seedMission('MATCHED')
    const res = await dropoff(mission.id, validBody)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('DEPOSITED')
    expect(body.dropoffReceiptUrl).toBe(validBody.dropoffReceiptUrl)
    expect(body.dropoffTrackingNumber).toBe(validBody.dropoffTrackingNumber)
    expect(body.dropoffAt).toBeTruthy()

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DEPOSITED')
    expect(db.dropoffAt).not.toBeNull()
  })

  it('(B) VALIDATED (post-douane) sans tracking → 200 DEPOSITED, tracking null', async () => {
    const mission = await seedMission('VALIDATED')
    const res = await dropoff(mission.id, { dropoffReceiptUrl: 'https://proofs.waylo.app/d2.png' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('DEPOSITED')
    expect(body.dropoffTrackingNumber).toBeNull()
  })

  it('(C) état invalide (IN_PROGRESS) → 400 INVALID_MISSION_STATE', async () => {
    const mission = await seedMission('IN_PROGRESS')
    const res = await dropoff(mission.id, validBody)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_MISSION_STATE' })

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('IN_PROGRESS') // inchangé
  })

  it('(D) dropoffReceiptUrl manquant → 400 INVALID_INPUT', async () => {
    const mission = await seedMission('MATCHED')
    const res = await dropoff(mission.id, { dropoffTrackingNumber: 'TRK-1' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  it('(E) URL non http(s) → 400 INVALID_INPUT (anti-XSS stocké)', async () => {
    const mission = await seedMission('MATCHED')
    const res = await dropoff(mission.id, { dropoffReceiptUrl: 'javascript:alert(1)' })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  it('(F) IDOR : acheteur → 404, tiers → 404, non authentifié → 401', async () => {
    const mission = await seedMission('MATCHED')

    expect((await dropoff(mission.id, validBody, bearer(buyerToken))).statusCode).toBe(404)
    expect((await dropoff(mission.id, validBody, bearer(strangerToken))).statusCode).toBe(404)
    expect((await dropoff(mission.id, validBody, {})).statusCode).toBe(401)

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('MATCHED') // aucune écriture
  })

  it('(G) double dépôt → 400 INVALID_MISSION_STATE (2e appel, anti-TOCTOU)', async () => {
    const mission = await seedMission('MATCHED')
    const first = await dropoff(mission.id, validBody)
    expect(first.statusCode).toBe(200)

    const second = await dropoff(mission.id, validBody)
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'INVALID_MISSION_STATE' })
  })

  it('(H) sceau ABSENT (MATCHED sans /ship) → génère le sceau : brut renvoyé, sha256 persisté', async () => {
    const mission = await seedMission('MATCHED')
    const res = await dropoff(mission.id, validBody)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.innerQrCode).toMatch(/^[0-9a-f]{64}$/) // code brut généré, renvoyé 1×

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.innerQrCodeHash).toBe(hashQrCode(body.innerQrCode)) // seul le hash en base
    expect(db.innerQrCodeHash).not.toBe(body.innerQrCode)
  })

  it('(I) sceau DÉJÀ présent (posé par /ship) → idempotent : pas de régénération, pas de brut renvoyé', async () => {
    const existingHash = hashQrCode('seal-pose-par-ship')
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'MATCHED' as never,
        targetProduct: 'Colis déjà scellé',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Paris',
        innerQrCodeHash: existingHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    const res = await dropoff(mission.id, validBody)

    expect(res.statusCode).toBe(200)
    expect(res.json().innerQrCode).toBeUndefined() // jamais re-dérivable → non renvoyé

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.innerQrCodeHash).toBe(existingHash) // sceau d'origine INCHANGÉ
  })
})
