import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { hashQrCode } from './qr-proof'

/**
 * Sceau QR interne — durcissement POST /api/missions/:id/receive.
 *
 * Le sceau QR est désormais OBLIGATOIRE sur le chemin de réception directe :
 * (A) bon QR + escrow HELD → 200 VALIDATED, capture 1× ;
 * (B) mauvais QR → 400 INVALID_QR_PROOF, aucune capture, mission intacte ;
 * (C) mission sans sceau (chemin /start-travel) → 400 NO_INNER_SEAL, aucune capture ;
 * (D) IDOR : voyageur → 404 (buyer-only), tiers → 404, no-auth → 401.
 *
 * Prérequis : DATABASE_URL → base waylo_test.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

const QR_RAW = 'WAYLO-RECEIVE-SEAL-TEST-7C3E9A'
const QR_HASH = hashQrCode(QR_RAW)

describe('Sceau QR interne — /receive durcissement obligatoire', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let stranger: User
  let buyerToken: string
  let travelerToken: string
  let strangerToken: string
  const captureCalls: Array<{ id: string; key: string }> = []

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async params => ({ id: `pi_rcv_${params.metadata['missionId']}`, client_secret: 'secret' }),
      capture: async (id, _params, options) => {
        captureCalls.push({ id, key: options.idempotencyKey })
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

    buyer = await prisma.user.create({ data: { email: 'buyer-rcv-seal@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-rcv-seal@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-rcv-seal@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    strangerToken = app.jwt.sign({ sub: stranger.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  async function seedInProgress(opts: { innerQrCodeHash?: string | null } = {}) {
    const hash = 'innerQrCodeHash' in opts ? opts.innerQrCodeHash : QR_HASH
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'IN_PROGRESS',
        targetProduct: 'Colis scellé',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Paris',
        innerQrCodeHash: hash ?? null,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_rcv_${mission.id}`,
        status: 'HELD',
        spendingLimitCents: 50_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission
  }

  const receive = (missionId: string, innerQrCode: string, headers: Record<string, string> = bearer(buyerToken)) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/receive`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ innerQrCode }),
    })

  it('(A) bon QR + escrow HELD → 200 VALIDATED, capture 1× clé capture_<id>', async () => {
    captureCalls.length = 0
    const mission = await seedInProgress()

    const res = await receive(mission.id, QR_RAW)

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('VALIDATED')
    expect(captureCalls).toHaveLength(1)
    expect(captureCalls[0]).toEqual({ id: `pi_rcv_${mission.id}`, key: `waylo:${mission.id}:cap:receive:v1` })
  })

  it('(B) mauvais QR → 400 INVALID_QR_PROOF, aucune capture Stripe, mission intacte', async () => {
    captureCalls.length = 0
    const mission = await seedInProgress()

    const res = await receive(mission.id, 'FAUX-CODE-WRONG')

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_QR_PROOF' })
    expect(captureCalls).toHaveLength(0)

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('IN_PROGRESS') // séquestre intact
  })

  it('(C) chemin /start-travel (pas de sceau) → 400 NO_INNER_SEAL, aucune capture', async () => {
    captureCalls.length = 0
    // Simule le bypass historique /start-travel → /receive : innerQrCodeHash null.
    const mission = await seedInProgress({ innerQrCodeHash: null })

    const res = await receive(mission.id, 'QUELQUE-CHOSE')

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'NO_INNER_SEAL' })
    expect(captureCalls).toHaveLength(0)

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('IN_PROGRESS')
  })

  it('(D) IDOR — voyageur → 404, tiers → 404, non authentifié → 401, aucune capture', async () => {
    captureCalls.length = 0
    const mission = await seedInProgress()

    expect((await receive(mission.id, QR_RAW, bearer(travelerToken))).statusCode).toBe(404)
    expect((await receive(mission.id, QR_RAW, bearer(strangerToken))).statusCode).toBe(404)
    expect((await receive(mission.id, QR_RAW, {})).statusCode).toBe(401)
    expect(captureCalls).toHaveLength(0)

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('IN_PROGRESS')
  })
})
