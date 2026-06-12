import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Brique 5 (fin) — découverte + dépôt/scellement de reçu :
 * - GET /available : missions FUNDED des AUTRES, pas les miennes, pas les MATCHED ;
 * - POST /:id/submit-receipt : voyageur assigné, mission IN_PROGRESS → 201,
 *   Receipt scellé (sha256), mission AWAITING_VALIDATION ; acheteur/tiers → 404 ;
 *   mauvais statut / double dépôt → 400.
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
const RECEIPT_URL = 'https://cdn.waylo.test/receipts/abc.jpg'
const PURCHASE_CENTS = 9_800

const expectedHash = (missionId: string, url: string, amount: number): string =>
  createHash('sha256').update(`${missionId}:${url}:${amount}`).digest('hex')

describe('Découverte & reçus — GET /available, POST /:id/submit-receipt', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let other: User
  let buyerToken: string
  let travelerToken: string

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
    await prisma.user.deleteMany()

    buyer = await prisma.user.create({ data: { email: 'buyer-receipt@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-receipt@test.waylo' } })
    other = await prisma.user.create({ data: { email: 'other-receipt@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const submitReceipt = (
    id: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => app.inject({ method: 'POST', url: `/api/missions/${id}/submit-receipt`, payload: body, headers })

  const seedMission = (overrides: {
    buyerId?: string
    status?: 'FUNDED' | 'MATCHED' | 'IN_PROGRESS'
    travelerId?: string
  } = {}) =>
    prisma.mission.create({
      data: {
        buyerId: overrides.buyerId ?? buyer.id,
        travelerId: overrides.travelerId ?? null,
        status: overrides.status ?? 'IN_PROGRESS',
        targetProduct: 'Article acheté',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

  // ── GET /available ─────────────────────────────────────────────────────────
  it('GET /available : missions FUNDED des autres, pas les miennes ni les MATCHED', async () => {
    const fundedByOther = await seedMission({ buyerId: buyer.id, status: 'FUNDED' }) // buyer ≠ traveler
    const fundedByTraveler = await seedMission({ buyerId: traveler.id, status: 'FUNDED' }) // la mienne
    const matched = await seedMission({
      buyerId: buyer.id,
      status: 'MATCHED',
      travelerId: other.id,
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/missions/available',
      headers: bearer(travelerToken),
    })
    expect(res.statusCode).toBe(200)
    const list = res.json() as Array<{ id: string; status: string; buyerId: string }>

    // Tout est FUNDED et appartient à un autre acheteur.
    expect(list.every(m => m.status === 'FUNDED' && m.buyerId !== traveler.id)).toBe(true)
    expect(list.some(m => m.id === fundedByOther.id)).toBe(true)
    expect(list.some(m => m.id === fundedByTraveler.id)).toBe(false) // pas les miennes
    expect(list.some(m => m.id === matched.id)).toBe(false) // pas les MATCHED
  })

  it('GET /available : non authentifié → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/missions/available' })
    expect(res.statusCode).toBe(401)
  })

  // ── POST /:id/submit-receipt ────────────────────────────────────────────────
  it('submit-receipt : voyageur, IN_PROGRESS → 201, reçu scellé, mission AWAITING_VALIDATION', async () => {
    const mission = await seedMission({ status: 'IN_PROGRESS', travelerId: traveler.id })
    const res = await submitReceipt(
      mission.id,
      { urlRecu: RECEIPT_URL, purchaseAmountCents: PURCHASE_CENTS },
      bearer(travelerToken),
    )
    expect(res.statusCode).toBe(201)
    const receipt = res.json() as { missionId: string; totalTtcCents: number; sha256Server: string; sha256Client: string }
    expect(receipt).toMatchObject({
      missionId: mission.id,
      totalTtcCents: PURCHASE_CENTS,
      sha256Server: expectedHash(mission.id, RECEIPT_URL, PURCHASE_CENTS),
    })

    // Persistance : ligne Receipt unique + mission passée en validation.
    const inDb = await prisma.receipt.findUniqueOrThrow({ where: { missionId: mission.id } })
    expect(inDb.sha256Server).toBe(expectedHash(mission.id, RECEIPT_URL, PURCHASE_CENTS))
    const after = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(after.status).toBe('AWAITING_VALIDATION')
  })

  it('submit-receipt : acheteur → 404 ; tiers → 404 ; aucun reçu créé', async () => {
    const mission = await seedMission({ status: 'IN_PROGRESS', travelerId: traveler.id })
    const body = { urlRecu: RECEIPT_URL, purchaseAmountCents: PURCHASE_CENTS }

    const byBuyer = await submitReceipt(mission.id, body, bearer(buyerToken))
    expect(byBuyer.statusCode).toBe(404)
    expect(byBuyer.json()).toEqual({ error: 'MISSION_NOT_FOUND' })

    const byOther = await submitReceipt(mission.id, body, bearer(app.jwt.sign({ sub: other.id })))
    expect(byOther.statusCode).toBe(404)

    expect(await prisma.receipt.count({ where: { missionId: mission.id } })).toBe(0)
    const after = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(after.status).toBe('IN_PROGRESS')
  })

  it('submit-receipt : mauvais statut (MATCHED) → 400', async () => {
    const mission = await seedMission({ status: 'MATCHED', travelerId: traveler.id })
    const res = await submitReceipt(
      mission.id,
      { urlRecu: RECEIPT_URL, purchaseAmountCents: PURCHASE_CENTS },
      bearer(travelerToken),
    )
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_IN_PROGRESS' })
  })

  it('submit-receipt : double dépôt → 400 (mission déjà AWAITING_VALIDATION, reçu inchangé)', async () => {
    const mission = await seedMission({ status: 'IN_PROGRESS', travelerId: traveler.id })
    const body = { urlRecu: RECEIPT_URL, purchaseAmountCents: PURCHASE_CENTS }

    const first = await submitReceipt(mission.id, body, bearer(travelerToken))
    expect(first.statusCode).toBe(201)
    const second = await submitReceipt(
      mission.id,
      { urlRecu: 'https://cdn.waylo.test/receipts/forge.jpg', purchaseAmountCents: 1 },
      bearer(travelerToken),
    )
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'MISSION_NOT_IN_PROGRESS' })

    // Reçu immuable : le 1er scellé n'a pas bougé.
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { missionId: mission.id } })
    expect(receipt.totalTtcCents).toBe(PURCHASE_CENTS)
  })

  it('submit-receipt : corps invalide (montant ≤ 0 / url manquante) → 400', async () => {
    const mission = await seedMission({ status: 'IN_PROGRESS', travelerId: traveler.id })
    const badAmount = await submitReceipt(
      mission.id,
      { urlRecu: RECEIPT_URL, purchaseAmountCents: 0 },
      bearer(travelerToken),
    )
    expect(badAmount.statusCode).toBe(400)
    expect(badAmount.json()).toEqual({ error: 'INVALID_INPUT' })

    const noUrl = await submitReceipt(
      mission.id,
      { purchaseAmountCents: PURCHASE_CENTS },
      bearer(travelerToken),
    )
    expect(noUrl.statusCode).toBe(400)
  })

  it('submit-receipt : non authentifié → 401', async () => {
    const mission = await seedMission({ status: 'IN_PROGRESS', travelerId: traveler.id })
    const res = await submitReceipt(mission.id, {
      urlRecu: RECEIPT_URL,
      purchaseAmountCents: PURCHASE_CENTS,
    })
    expect(res.statusCode).toBe(401)
  })
})
