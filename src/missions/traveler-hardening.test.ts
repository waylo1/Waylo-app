import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Hardening voyageur — garde « carte de garantie » sur l'acceptation de mission
 * (Sprint 13). Un voyageur ne peut prendre une mission (POST /:id/match) ni
 * l'accepter (POST /:id/accept) sans `stripePaymentMethodId` enregistré : cette
 * carte adosse la future ponction de pénalité en cas de fraude. Sans elle →
 * 400 TRAVELER_CARD_MISSING, AUCUNE assignation (mission reste FUNDED, travelerId null).
 *
 * NOTE — le moteur de pénalité asymétrique 120/200 (débit voyageur / restitution
 * acheteur / marge plateforme) est DÉLIBÉRÉMENT hors de ce sprint : il introduit
 * un flux d'argent entrant (charge carte voyageur) incompatible avec le ledger
 * ancré escrow (invariant B : Σ(PAYOUT+COMMISSION+REFUND) ≤ Σ(CAPTURE)) et sans
 * primitive de débit dans PaymentIntentClient. Il fera l'objet d'un sprint dédié
 * (nouveaux LedgerType + PenaltyDebitOutbox + maj reconciliation). Aucun test de
 * calcul ledger ici : l'arbitrage de fraude n'existe pas encore.
 *
 * (A) /accept sans carte → 400 TRAVELER_CARD_MISSING ; mission FUNDED intacte ;
 * (B) /match sans carte → 400 TRAVELER_CARD_MISSING (même garde sur les deux routes) ;
 * (C) /accept avec carte → 200 MATCHED, travelerId posé ;
 * (D) /match avec carte → 200 MATCHED.
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

describe('Hardening voyageur — garde carte de garantie (Sprint 13)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let travelerNoCard: User
  let travelerWithCard: User
  let noCardToken: string
  let withCardToken: string

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

    buyer = await prisma.user.create({ data: { email: 'buyer-hardening@test.waylo' } })
    travelerNoCard = await prisma.user.create({
      data: { email: 'traveler-nocard@test.waylo' },
    })
    travelerWithCard = await prisma.user.create({
      data: {
        email: 'traveler-withcard@test.waylo',
        stripePaymentMethodId: 'pm_test_guarantee_card',
      },
    })

    noCardToken = app.jwt.sign({ sub: travelerNoCard.id })
    withCardToken = app.jwt.sign({ sub: travelerWithCard.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  /** Mission finançée, sans voyageur — éligible à /match et /accept. */
  function seedFunded() {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'FUNDED',
        targetProduct: 'Sneakers Sprint 13',
        budgetCents: 35_000,
        commissionCents: 3_500,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  const accept = (missionId: string, token: string) =>
    app.inject({ method: 'POST', url: `/api/missions/${missionId}/accept`, headers: bearer(token) })
  const match = (missionId: string, token: string) =>
    app.inject({ method: 'POST', url: `/api/missions/${missionId}/match`, headers: bearer(token) })

  it('(A) /accept sans carte → 400 TRAVELER_CARD_MISSING ; mission FUNDED intacte', async () => {
    const mission = await seedFunded()
    const res = await accept(mission.id, noCardToken)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'TRAVELER_CARD_MISSING' })

    // Aucune assignation : mission toujours FUNDED, travelerId null.
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('FUNDED')
    expect(db.travelerId).toBeNull()
  })

  it('(B) /match sans carte → 400 TRAVELER_CARD_MISSING (même garde sur les deux routes)', async () => {
    const mission = await seedFunded()
    const res = await match(mission.id, noCardToken)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'TRAVELER_CARD_MISSING' })

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('FUNDED')
    expect(db.travelerId).toBeNull()
  })

  it('(C) /accept avec carte → 200 MATCHED, travelerId posé', async () => {
    const mission = await seedFunded()
    const res = await accept(mission.id, withCardToken)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'MATCHED', travelerId: travelerWithCard.id })

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('MATCHED')
    expect(db.travelerId).toBe(travelerWithCard.id)
  })

  it('(D) /match avec carte → 200 MATCHED', async () => {
    const mission = await seedFunded()
    const res = await match(mission.id, withCardToken)

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'MATCHED', travelerId: travelerWithCard.id })
  })
})
