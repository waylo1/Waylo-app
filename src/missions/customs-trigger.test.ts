import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { CUSTOMS_THRESHOLD_CENTS } from './customs'

/**
 * Trigger douanier — POST /api/missions/:id/receive :
 * (A) purchaseAmountCents > seuil EU (43 000 ¢) → ESCROW_LOCKED_CUSTOMS, aucune capture ;
 * (B) purchaseAmountCents = seuil (non strictement supérieur) → capture normale ;
 * (C) purchaseAmountCents > seuil US (80 000 ¢) → ESCROW_LOCKED_CUSTOMS ;
 * (D) sans destinationCountry → aucun verrou (fallback : capture normale).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

const BUDGET_CENTS = 50_000
const COMMISSION_CENTS = 5_000

describe('Trigger douanier — POST /api/missions/:id/receive', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let buyerToken: string
  const captureCalls: string[] = []

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({
        id: `pi_customs_${params.metadata['missionId']}`,
        client_secret: 'secret_customs',
      }),
      capture: async (id) => {
        captureCalls.push(id)
        return { id }
      },
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

    buyer = await prisma.user.create({ data: { email: 'buyer-customs@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-customs@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const receive = (missionId: string) =>
    app.inject({ method: 'POST', url: `/api/missions/${missionId}/receive`, headers: bearer(buyerToken) })

  async function seedInProgress(opts: {
    destinationCountry?: string
    purchaseAmountCents: number
  }): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'IN_PROGRESS',
        targetProduct: 'Article douane',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        destinationCountry: opts.destinationCountry ?? null,
        purchaseAmountCents: opts.purchaseAmountCents,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_customs_${mission.id}`,
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
        status: 'HELD',
      },
    })
    return mission.id
  }

  it('(A) purchaseAmountCents > seuil EU → ESCROW_LOCKED_CUSTOMS, aucune capture Stripe', async () => {
    captureCalls.length = 0
    const missionId = await seedInProgress({
      destinationCountry: 'FR',
      purchaseAmountCents: CUSTOMS_THRESHOLD_CENTS + 1, // 43 001 ¢ > 43 000 ¢
    })

    const res = await receive(missionId)

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ESCROW_LOCKED_CUSTOMS')
    expect(captureCalls).toHaveLength(0) // aucune capture tant que taxes non prouvées

    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe('ESCROW_LOCKED_CUSTOMS')
  })

  it('(B) purchaseAmountCents = seuil EU (non strictement supérieur) → capture normale', async () => {
    captureCalls.length = 0
    const missionId = await seedInProgress({
      destinationCountry: 'DE',
      purchaseAmountCents: CUSTOMS_THRESHOLD_CENTS, // 43 000 ¢ = seuil exact, pas de verrou
    })

    const res = await receive(missionId)

    // Capture appelée, mission VALIDATED (transitoire avant webhook).
    expect(captureCalls).toHaveLength(1)
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('VALIDATED')
  })

  it('(C) purchaseAmountCents > seuil US (80 000 ¢) → ESCROW_LOCKED_CUSTOMS', async () => {
    captureCalls.length = 0
    const missionId = await seedInProgress({
      destinationCountry: 'US',
      purchaseAmountCents: 80_001, // > 800 € seuil US
    })

    const res = await receive(missionId)

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ESCROW_LOCKED_CUSTOMS')
    expect(captureCalls).toHaveLength(0)
  })

  it('(D) sans destinationCountry → aucun verrou douanier → capture normale', async () => {
    captureCalls.length = 0
    const missionId = await seedInProgress({
      destinationCountry: undefined,
      purchaseAmountCents: 500_000, // montant très élevé mais pas de pays → pas de contrôle
    })

    const res = await receive(missionId)

    expect(captureCalls).toHaveLength(1)
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('VALIDATED')
  })
})
