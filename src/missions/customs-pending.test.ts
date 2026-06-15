import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission.route'

/**
 * GET /api/missions/customs-pending — file d'attente de validation ops/admin :
 * (A) seules les missions PENDING_CUSTOMS_REVIEW sont retournées (pas ESCROW_LOCKED_CUSTOMS,
 *     pas IN_PROGRESS) ;
 * (B) la réponse contient id, budgetCents, purchaseAmountCents, destinationCountry,
 *     customsReceiptUrl, customsReceiptSha256 ;
 * (C) un non-admin reçoit 403 ; non authentifié → 401.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

const ADMIN_ID = 'admin-customs-pending-test'
process.env.ADMIN_USER_IDS = ADMIN_ID

describe('GET /api/missions/customs-pending', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let adminToken: string
  let buyerToken: string

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({
        id: `pi_cp_${params.metadata['missionId']}`,
        client_secret: 'secret',
      }),
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
    await prisma.user.deleteMany()

    buyer = await prisma.user.create({ data: { email: 'buyer-cp@test.waylo' } })
    adminToken = app.jwt.sign({ sub: ADMIN_ID })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/missions/customs-pending', headers })
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  async function seedMission(status: 'PENDING_CUSTOMS_REVIEW' | 'ESCROW_LOCKED_CUSTOMS' | 'IN_PROGRESS', overrides: {
    purchaseAmountCents?: number
    customsReceiptUrl?: string
    customsReceiptSha256?: string
    destinationCountry?: string
  } = {}) {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status,
        targetProduct: 'Article test',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        destinationCountry: overrides.destinationCountry ?? 'JP',
        purchaseAmountCents: overrides.purchaseAmountCents ?? 45_000,
        customsReceiptUrl: overrides.customsReceiptUrl ?? null,
        customsReceiptSha256: overrides.customsReceiptSha256 ?? null,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  it('(A) retourne uniquement les missions PENDING_CUSTOMS_REVIEW', async () => {
    const pending = await seedMission('PENDING_CUSTOMS_REVIEW', {
      customsReceiptUrl: 'https://receipts.waylo.app/r1.pdf',
      customsReceiptSha256: 'abc123',
    })
    await seedMission('ESCROW_LOCKED_CUSTOMS') // ne doit pas apparaître
    await seedMission('IN_PROGRESS')            // ne doit pas apparaître

    const res = await get(bearer(adminToken))

    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string; status?: string }>
    const ids = body.map(m => m.id)
    expect(ids).toContain(pending.id)
    expect(ids).not.toContain(undefined)
    // Aucune mission non-PENDING ne doit filtrer dans la liste.
    expect(body.length).toBe(1)
  })

  it('(B) la réponse contient les champs nécessaires à la validation ops', async () => {
    const res = await get(bearer(adminToken))
    expect(res.statusCode).toBe(200)
    const [mission] = res.json() as Array<Record<string, unknown>>
    expect(mission).toMatchObject({
      id: expect.any(String),
      budgetCents: 50_000,
      purchaseAmountCents: 45_000,
      destinationCountry: 'JP',
      customsReceiptUrl: 'https://receipts.waylo.app/r1.pdf',
      customsReceiptSha256: 'abc123',
    })
  })

  it('(C) non-admin → 403 ; non authentifié → 401', async () => {
    const forbidden = await get(bearer(buyerToken))
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toEqual({ error: 'FORBIDDEN' })

    const unauth = await get()
    expect(unauth.statusCode).toBe(401)
    expect(unauth.json()).toEqual({ error: 'UNAUTHORIZED' })
  })
})
