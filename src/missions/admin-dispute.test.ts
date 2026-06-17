import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission.route'

/**
 * Arbitrage admin d'un litige (§8) — résolution d'une mission DISPUTED.
 *
 * resolve-refund : DISPUTED → CANCELLED (faveur acheteur), annule le hold HELD
 *                  (paymentIntents.cancel, clé admin_refund_<id>) — jamais capturé.
 * resolve-payout : DISPUTED → VALIDATED (faveur voyageur), capture le hold HELD
 *                  (paymentIntents.capture, clé admin_payout_<id>) ; webhook finalise.
 *
 * (A) resolve-refund happy : CANCELLED, cancel Stripe, audit ADMIN_RESOLVE_REFUND ;
 * (B) resolve-payout happy : VALIDATED, capture Stripe, audit ADMIN_RESOLVE_PAYOUT ;
 * (C) non-admin → 403 ; non authentifié → 401 (les deux routes) ;
 * (D) mission non-DISPUTED → 400 MISSION_NOT_DISPUTED (les deux routes) ;
 * (E) idempotence : 2e appel → 400, une seule action Stripe, un seul audit.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('Arbitrage admin litige — resolve-refund / resolve-payout', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let admin: User
  let adminToken: string
  let buyerToken: string

  const cancelCalls: Array<{ id: string; idempotencyKey: string }> = []
  const captureCalls: Array<{ id: string; idempotencyKey: string }> = []

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({ id: `pi_ad_${params.metadata['missionId']}`, client_secret: 'secret' }),
      capture: async (id, _params, options) => {
        captureCalls.push({ id, idempotencyKey: options.idempotencyKey })
        return { id }
      },
      cancel: async (id, _params, options) => {
        cancelCalls.push({ id, idempotencyKey: options.idempotencyKey })
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

    buyer = await prisma.user.create({ data: { email: 'buyer-ad@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-ad@test.waylo' } })
    admin = await prisma.user.create({ data: { email: 'admin-ad@test.waylo', isAdmin: true } })
    adminToken = app.jwt.sign({ sub: admin.id })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const resolveRefund = (id: string, headers: Record<string, string> = bearer(adminToken)) =>
    app.inject({ method: 'POST', url: `/api/missions/${id}/admin/resolve-refund`, headers })
  const resolvePayout = (id: string, headers: Record<string, string> = bearer(adminToken)) =>
    app.inject({ method: 'POST', url: `/api/missions/${id}/admin/resolve-payout`, headers })

  // Mission gelée (DISPUTED) + escrow HELD : l'état exact post-/dispute. `status`
  // surcharge la valeur passée (DEPOSITED) pour le cas (D) non-DISPUTED.
  async function seedDisputed(status: 'DISPUTED' | 'DEPOSITED' = 'DISPUTED') {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status,
        targetProduct: 'Article litigieux',
        budgetCents: 60_000,
        commissionCents: 6_000,
        destination: 'Séoul',
        destinationCountry: 'KR',
        dropoffReceiptUrl: 'https://receipts.waylo.app/dropoff.pdf',
        dropoffAt: new Date(Date.now() - 3600 * 1000),
        disputeReason: status === 'DISPUTED' ? 'Colis endommagé' : null,
        disputedAt: status === 'DISPUTED' ? new Date() : null,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_dispute_${mission.id}`,
        spendingLimitCents: 60_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission
  }

  it('(A) resolve-refund : DISPUTED → CANCELLED, cancel Stripe (admin_refund_<id>), audit tracé', async () => {
    const mission = await seedDisputed()
    const res = await resolveRefund(mission.id)

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('CANCELLED')

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('CANCELLED')

    // Annulation Stripe du hold non capturé, clé déterministe.
    expect(cancelCalls).toContainEqual({
      id: `pi_dispute_${mission.id}`,
      idempotencyKey: `admin_refund_${mission.id}`,
    })

    const audit = await prisma.adminAuditLog.findMany({ where: { missionId: mission.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ adminId: admin.id, action: 'ADMIN_RESOLVE_REFUND', missionId: mission.id })
  })

  it('(B) resolve-payout : DISPUTED → VALIDATED, capture Stripe (admin_payout_<id>), audit tracé', async () => {
    const mission = await seedDisputed()
    const res = await resolvePayout(mission.id)

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('VALIDATED')

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('VALIDATED')

    expect(captureCalls).toContainEqual({
      id: `pi_dispute_${mission.id}`,
      idempotencyKey: `admin_payout_${mission.id}`,
    })

    const audit = await prisma.adminAuditLog.findMany({ where: { missionId: mission.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ adminId: admin.id, action: 'ADMIN_RESOLVE_PAYOUT', missionId: mission.id })
  })

  it('(C) non-admin → 403 ; non authentifié → 401 (resolve-refund et resolve-payout)', async () => {
    const mission = await seedDisputed()

    expect((await resolveRefund(mission.id, bearer(buyerToken))).statusCode).toBe(403)
    expect((await resolveRefund(mission.id, {})).statusCode).toBe(401)
    expect((await resolvePayout(mission.id, bearer(buyerToken))).statusCode).toBe(403)
    expect((await resolvePayout(mission.id, {})).statusCode).toBe(401)

    // Garde admin AVANT tout effet : la mission reste gelée, aucun mouvement.
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DISPUTED')
  })

  it('(D) mission non-DISPUTED → 400 MISSION_NOT_DISPUTED (resolve-refund et resolve-payout)', async () => {
    const refundMission = await seedDisputed('DEPOSITED')
    const refundRes = await resolveRefund(refundMission.id)
    expect(refundRes.statusCode).toBe(400)
    expect(refundRes.json()).toEqual({ error: 'MISSION_NOT_DISPUTED' })

    const payoutMission = await seedDisputed('DEPOSITED')
    const payoutRes = await resolvePayout(payoutMission.id)
    expect(payoutRes.statusCode).toBe(400)
    expect(payoutRes.json()).toEqual({ error: 'MISSION_NOT_DISPUTED' })
  })

  it('(E) idempotence : 2e arbitrage → 400, une seule action Stripe, un seul audit', async () => {
    // refund : 1er OK → CANCELLED ; 2e voit la mission déjà soldée → 400 sans re-cancel.
    const refundMission = await seedDisputed()
    expect((await resolveRefund(refundMission.id)).statusCode).toBe(200)
    const refundReplay = await resolveRefund(refundMission.id)
    expect(refundReplay.statusCode).toBe(400)
    expect(refundReplay.json()).toEqual({ error: 'MISSION_NOT_DISPUTED' })
    expect(cancelCalls.filter(c => c.id === `pi_dispute_${refundMission.id}`)).toHaveLength(1)
    expect(await prisma.adminAuditLog.count({ where: { missionId: refundMission.id } })).toBe(1)

    // payout : symétrique.
    const payoutMission = await seedDisputed()
    expect((await resolvePayout(payoutMission.id)).statusCode).toBe(200)
    const payoutReplay = await resolvePayout(payoutMission.id)
    expect(payoutReplay.statusCode).toBe(400)
    expect(payoutReplay.json()).toEqual({ error: 'MISSION_NOT_DISPUTED' })
    expect(captureCalls.filter(c => c.id === `pi_dispute_${payoutMission.id}`)).toHaveLength(1)
    expect(await prisma.adminAuditLog.count({ where: { missionId: payoutMission.id } })).toBe(1)
  })
})
