import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { hashQrCode } from './qr-proof'

/**
 * Sceau QR interne — génération automatique à POST /:id/ship (entrée du flux
 * transport) + interlock avec /confirm-collection.
 *
 * (1) /ship génère un code aléatoire 256 bits, renvoie le BRUT une seule fois
 *     (pour impression/scellage) et ne persiste QUE son sha256 ;
 * (2) ce code brut — et lui seul — débloque /confirm-collection (→ VALIDATED) ;
 *     un faux code est rejeté (400 INVALID_QR_PROOF), séquestre intact.
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

describe('Sceau QR interne — génération à /ship + interlock /confirm-collection', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let buyerToken: string
  let travelerToken: string

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({ id: `pi_qr_${params.metadata['missionId']}`, client_secret: 'secret' }),
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

    buyer = await prisma.user.create({ data: { email: 'buyer-qr@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-qr@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

  async function seedMatched() {
    return prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'MATCHED' as never,
        targetProduct: 'Colis scellé',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Nice',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  const ship = (id: string) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${id}/ship`,
      headers: { ...bearer(travelerToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ trackingReference: 'TRK-QR-1', purchaseAmountCents: 40_000 }),
    })

  const confirmWithQr = (id: string, innerQrCode: string) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${id}/confirm-collection`,
      headers: { ...bearer(buyerToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ innerQrCode }),
    })

  it('/ship génère le sceau : renvoie le code brut (64 hex) 1×, ne persiste QUE le sha256', async () => {
    const mission = await seedMatched()
    const res = await ship(mission.id)

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('IN_PROGRESS')
    expect(body.innerQrCode).toMatch(/^[0-9a-f]{64}$/) // 256 bits aléatoires

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    // Seul le hash est persisté ; jamais le code brut.
    expect(db.innerQrCodeHash).toBe(hashQrCode(body.innerQrCode))
    expect(db.innerQrCodeHash).not.toBe(body.innerQrCode)
  })

  it('interlock : le brut de /ship débloque /confirm-collection (→ VALIDATED) ; un faux est rejeté', async () => {
    const mission = await seedMatched()
    const raw = (await ship(mission.id)).json().innerQrCode as string

    // Raccourci jusqu'à DEPOSITED + escrow HELD (chemins couverts ailleurs).
    await prisma.mission.update({
      where: { id: mission.id },
      data: {
        status: 'DEPOSITED' as never,
        dropoffReceiptUrl: 'https://proofs.waylo.app/d.pdf',
        dropoffAt: new Date(),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_qr_${mission.id}`,
        status: 'HELD' as never,
        spendingLimitCents: 50_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })

    // Faux code → 400, séquestre jamais libéré.
    const wrong = await confirmWithQr(mission.id, 'f'.repeat(64))
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json()).toEqual({ error: 'INVALID_QR_PROOF' })
    expect((await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })).status).toBe('DEPOSITED')

    // Vrai code (celui scellé par /ship) → 200 VALIDATED.
    const ok = await confirmWithQr(mission.id, raw)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('VALIDATED')
  })
})
