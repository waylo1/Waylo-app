import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission.route'

/**
 * Workflow d'approbation douanière admin :
 * customs-approve : PENDING_CUSTOMS_REVIEW → IN_PROGRESS (admin only)
 * customs-reject  : PENDING_CUSTOMS_REVIEW → ESCROW_LOCKED_CUSTOMS, receipt effacé (admin only)
 *
 * (A) approve : statut IN_PROGRESS, receipt conservé ;
 * (B) approve sur mission non-PENDING → 400 MISSION_NOT_CUSTOMS_REVIEW ;
 * (C) reject : statut ESCROW_LOCKED_CUSTOMS, receipt nettoyé, re-soumission possible ;
 * (D) reject sur mission non-PENDING → 400 MISSION_NOT_CUSTOMS_REVIEW ;
 * (E) non-admin → 403 sur les deux routes ; non authentifié → 401.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('Approbation douanière admin — customs-approve / customs-reject', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let admin: User
  let adminToken: string
  let buyerToken: string

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({ id: `pi_ca_${params.metadata['missionId']}`, client_secret: 'secret' }),
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

    buyer = await prisma.user.create({ data: { email: 'buyer-ca@test.waylo' } })
    admin = await prisma.user.create({ data: { email: 'admin-ca@test.waylo', isAdmin: true } })
    adminToken = app.jwt.sign({ sub: admin.id })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const approve = (id: string, headers: Record<string, string> = bearer(adminToken)) =>
    app.inject({ method: 'POST', url: `/api/missions/${id}/customs-approve`, headers })
  const reject = (id: string, headers: Record<string, string> = bearer(adminToken)) =>
    app.inject({ method: 'POST', url: `/api/missions/${id}/customs-reject`, headers })

  async function seedPending() {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'PENDING_CUSTOMS_REVIEW',
        targetProduct: 'Article douane',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        destinationCountry: 'JP',
        purchaseAmountCents: 45_000,
        customsReceiptUrl: 'https://receipts.waylo.app/qr.pdf',
        customsReceiptSha256: 'sha256hashtest',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    // Escrow HELD requis pour la capture Stripe déclenchée par customs-approve.
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_customs_${mission.id}`,
        spendingLimitCents: 50_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission
  }

  it('(A) approve : PENDING_CUSTOMS_REVIEW → VALIDATED (capture Stripe déclenchée), receipt conservé', async () => {
    const mission = await seedPending()
    const res = await approve(mission.id)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('VALIDATED')
    expect(body.customsReceiptUrl).toBe('https://receipts.waylo.app/qr.pdf')

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('VALIDATED')

    // Audit append-only : la décision admin est tracée (adminId, action, missionId).
    const audit = await prisma.adminAuditLog.findMany({ where: { missionId: mission.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ adminId: admin.id, action: 'CUSTOMS_APPROVE', missionId: mission.id })
  })

  it('(B) approve sur mission non-PENDING → 400 MISSION_NOT_CUSTOMS_REVIEW', async () => {
    const mission = await seedPending()
    await approve(mission.id) // passage VALIDATED
    const res = await approve(mission.id) // deuxième appel : plus PENDING

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_CUSTOMS_REVIEW' })
  })

  it('(C) reject : PENDING_CUSTOMS_REVIEW → ESCROW_LOCKED_CUSTOMS, receipt nettoyé', async () => {
    const mission = await seedPending()
    const res = await reject(mission.id)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('ESCROW_LOCKED_CUSTOMS')
    expect(body.customsReceiptUrl).toBeNull()
    expect(body.customsReceiptSha256).toBeNull()

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('ESCROW_LOCKED_CUSTOMS')
    expect(db.customsReceiptUrl).toBeNull()

    // Audit append-only : le rejet admin est tracé.
    const audit = await prisma.adminAuditLog.findMany({ where: { missionId: mission.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ adminId: admin.id, action: 'CUSTOMS_REJECT', missionId: mission.id })
  })

  it('(D) reject sur mission non-PENDING → 400 MISSION_NOT_CUSTOMS_REVIEW', async () => {
    const mission = await seedPending()
    await reject(mission.id) // passage ESCROW_LOCKED_CUSTOMS
    const res = await reject(mission.id) // plus PENDING

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_CUSTOMS_REVIEW' })
  })

  it('(E) non-admin → 403 ; non authentifié → 401 (approve et reject)', async () => {
    const mission = await seedPending()

    expect((await approve(mission.id, bearer(buyerToken))).statusCode).toBe(403)
    expect((await approve(mission.id, {})).statusCode).toBe(401)
    expect((await reject(mission.id, bearer(buyerToken))).statusCode).toBe(403)
    expect((await reject(mission.id, {})).statusCode).toBe(401)
  })
})
