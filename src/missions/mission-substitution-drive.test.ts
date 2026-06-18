import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Substitution « Drive » (Sprint 16) — POST /api/missions/:id/submit-receipt.
 *
 * Modèle Drive : pas d'attente synchrone en rayon. L'acheteur pré-autorise la
 * substitution à la commande (`Mission.substitutionAuthorized`). Au scellement du
 * reçu, le voyageur peut donc soumettre un `purchaseAmountCents` > budget jusqu'à
 * un PLAFOND STRICT de 120% du budget — sans blocage. La `SubstitutionRequest` est
 * alors scellée `APPROVED` (terme métier « ACCEPTED » du workflow) dans la MÊME
 * transaction que le reçu. Aucun nouveau `MissionStatus` : le flux reste
 * `IN_PROGRESS → AWAITING_VALIDATION`.
 *
 * (1) Pas d'autorisation + reçu > budget → 400 `RECEIPT_AMOUNT_EXCEEDS_BUDGET`,
 *     aucun reçu, aucune substitution, mission intacte (comportement historique).
 * (2) Autorisé + reçu ≤ 120% → 201, reçu scellé, `SubstitutionRequest` APPROVED
 *     (montant = reçu), mission `AWAITING_VALIDATION`.
 * (3) Autorisé + reçu > 120% → 400 `SUBSTITUTION_PRICE_EXCEEDS_LIMIT`, aucun effet.
 *     (+ non autorisé + reçu > 120% → 400 `RECEIPT_AMOUNT_EXCEEDS_BUDGET` : la garde
 *      d'autorisation prime.)
 * (4) Autorisé mais reçu ≤ budget → 201 SANS substitution (achat nominal).
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

const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500
const CAP_CENTS = Math.floor((BUDGET_CENTS * 12) / 10) // 12_000 (120%, strict)
const RECEIPT_URL = 'https://cdn.waylo.test/receipts/substitute.jpg'
const TARGET_PRODUCT = 'Sneakers édition limitée'

describe('Substitution Drive — POST /:id/submit-receipt (Sprint 16)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let travelerToken: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()
    await wipe()
    buyer = await prisma.user.create({ data: { email: 'buyer-sub-drive@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-sub-drive@test.waylo' } })
    travelerToken = app.jwt.sign({ sub: traveler.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  async function wipe(): Promise<void> {
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
  }

  // Purge les missions entre cas (les users survivent) — chaque test seed la sienne.
  beforeEach(async () => {
    await prisma.substitutionRequest.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.mission.deleteMany()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const submitReceipt = (id: string, purchaseAmountCents: number) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${id}/submit-receipt`,
      payload: { urlRecu: RECEIPT_URL, purchaseAmountCents },
      headers: bearer(travelerToken),
    })

  function seedMission(substitutionAuthorized: boolean) {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'IN_PROGRESS',
        targetProduct: TARGET_PRODUCT,
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        substitutionAuthorized,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  it('(1) pas d’autorisation + reçu > budget → 400 RECEIPT_AMOUNT_EXCEEDS_BUDGET, aucun effet', async () => {
    const mission = await seedMission(false)
    const res = await submitReceipt(mission.id, BUDGET_CENTS + 1)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'RECEIPT_AMOUNT_EXCEEDS_BUDGET' })

    expect(await prisma.receipt.count({ where: { missionId: mission.id } })).toBe(0)
    expect(await prisma.substitutionRequest.count({ where: { missionId: mission.id } })).toBe(0)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('IN_PROGRESS')
  })

  it('(2) autorisé + reçu = 120% du budget → 201, reçu scellé, SubstitutionRequest APPROVED, AWAITING_VALIDATION', async () => {
    const mission = await seedMission(true)
    const res = await submitReceipt(mission.id, CAP_CENTS) // exactement 120% (borne incluse)

    expect(res.statusCode).toBe(201)

    // Reçu scellé.
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { missionId: mission.id } })
    expect(receipt.totalTtcCents).toBe(CAP_CENTS)

    // Substitution pré-validée → APPROVED, montant = reçu, résolue immédiatement.
    const subs = await prisma.substitutionRequest.findMany({ where: { missionId: mission.id } })
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({
      status: 'APPROVED',
      proposedPriceCents: CAP_CENTS,
      proposedProduct: TARGET_PRODUCT,
      lineItemRef: 'MAIN',
    })
    expect(subs[0]?.resolvedAt).not.toBeNull()

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('AWAITING_VALIDATION')
  })

  it('(2bis) autorisé + reçu intermédiaire (115%) → 201 + substitution APPROVED', async () => {
    const mission = await seedMission(true)
    const price = 11_500 // 115%
    const res = await submitReceipt(mission.id, price)

    expect(res.statusCode).toBe(201)
    const subs = await prisma.substitutionRequest.findMany({ where: { missionId: mission.id } })
    expect(subs).toHaveLength(1)
    expect(subs[0]?.proposedPriceCents).toBe(price)
  })

  it('(3) autorisé + reçu > 120% → 400 SUBSTITUTION_PRICE_EXCEEDS_LIMIT, aucun effet', async () => {
    const mission = await seedMission(true)
    const res = await submitReceipt(mission.id, CAP_CENTS + 1) // 120% + 1 centime

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'SUBSTITUTION_PRICE_EXCEEDS_LIMIT' })

    expect(await prisma.receipt.count({ where: { missionId: mission.id } })).toBe(0)
    expect(await prisma.substitutionRequest.count({ where: { missionId: mission.id } })).toBe(0)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('IN_PROGRESS')
  })

  it('(3bis) NON autorisé + reçu > 120% → 400 RECEIPT_AMOUNT_EXCEEDS_BUDGET (la garde d’autorisation prime)', async () => {
    const mission = await seedMission(false)
    const res = await submitReceipt(mission.id, CAP_CENTS + 5_000)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'RECEIPT_AMOUNT_EXCEEDS_BUDGET' })
    expect(await prisma.substitutionRequest.count({ where: { missionId: mission.id } })).toBe(0)
  })

  it('(4) autorisé mais reçu ≤ budget → 201 SANS substitution (achat nominal)', async () => {
    const mission = await seedMission(true)
    const res = await submitReceipt(mission.id, BUDGET_CENTS - 200) // sous le budget

    expect(res.statusCode).toBe(201)
    expect(await prisma.receipt.count({ where: { missionId: mission.id } })).toBe(1)
    // Pas de substitution : le reçu tient dans le budget initial.
    expect(await prisma.substitutionRequest.count({ where: { missionId: mission.id } })).toBe(0)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('AWAITING_VALIDATION')
  })
})
