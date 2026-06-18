import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { hashQrCode } from './qr-proof'

/**
 * Confirmation de collecte acheteur — POST /api/missions/:id/confirm-collection.
 * L'acheteur confirme la collecte d'un colis DEPOSITED → déclenche la capture du
 * séquestre via le chemin financier EXISTANT (aucun transfers.create ni écriture
 * ledger ici) : capture Stripe hors tx → DEPOSITED → VALIDATED (transitoire) ; le
 * webhook payment_intent.succeeded journalise PAYOUT/COMMISSION + TransferOutbox →
 * le worker exécute le transfert → RELEASED.
 *
 * (A) acheteur + DEPOSITED + escrow HELD → 200 VALIDATED, capture appelée 1× avec
 *     la clé déterministe capture_collection_<id> ;
 * (B) état non-DEPOSITED (MATCHED) → 400 INVALID_MISSION_STATE, aucune capture ;
 * (C) escrow non HELD (déjà RELEASED) → 400 ESCROW_NOT_HELD, aucune capture ;
 * (D) IDOR : voyageur → 404, tiers → 404, non authentifié → 401, aucune capture ;
 * (E) double confirmation (2e appel après VALIDATED) → 400 INVALID_MISSION_STATE.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('Confirmation de collecte acheteur — confirm-collection', () => {
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
      create: async (params) => ({ id: `pi_cc_${params.metadata['missionId']}`, client_secret: 'secret' }),
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

    buyer = await prisma.user.create({ data: { email: 'buyer-cc@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-cc@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-cc@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    strangerToken = app.jwt.sign({ sub: stranger.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const confirm = (id: string, headers: Record<string, string> = bearer(buyerToken)) =>
    app.inject({ method: 'POST', url: `/api/missions/${id}/confirm-collection`, headers })
  const confirmWithQr = (id: string, innerQrCode: string, headers: Record<string, string> = bearer(buyerToken)) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${id}/confirm-collection`,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: JSON.stringify({ innerQrCode }),
    })

  /** Mission DEPOSITED + escrow HELD (capturable). escrowStatus surchargeable. */
  async function seedDeposited(
    opts: { status?: string; escrowStatus?: string; innerQrCodeHash?: string } = {},
  ) {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: (opts.status ?? 'DEPOSITED') as never,
        targetProduct: 'Colis collecte',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Lyon',
        dropoffReceiptUrl: 'https://proofs.waylo.app/d.pdf',
        dropoffAt: new Date(),
        innerQrCodeHash: opts.innerQrCodeHash ?? null,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_cc_${mission.id}`,
        status: (opts.escrowStatus ?? 'HELD') as never,
        spendingLimitCents: 50_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission
  }

  it('(A) acheteur + DEPOSITED + escrow HELD → 200 VALIDATED, capture 1× clé capture_collection_<id>', async () => {
    captureCalls.length = 0
    const mission = await seedDeposited()
    const res = await confirm(mission.id)

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('VALIDATED')

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('VALIDATED')

    // Capture déléguée à Stripe, hors tx, clé déterministe propre au chemin collecte.
    expect(captureCalls).toHaveLength(1)
    expect(captureCalls[0]).toEqual({ id: `pi_cc_${mission.id}`, key: `capture_collection_${mission.id}` })
  })

  it('(B) état non-DEPOSITED (MATCHED) → 400 INVALID_MISSION_STATE, aucune capture', async () => {
    captureCalls.length = 0
    const mission = await seedDeposited({ status: 'MATCHED' })
    const res = await confirm(mission.id)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_MISSION_STATE' })
    expect(captureCalls).toHaveLength(0)
  })

  it('(C) escrow non HELD (RELEASED) → 400 ESCROW_NOT_HELD, aucune capture', async () => {
    captureCalls.length = 0
    const mission = await seedDeposited({ escrowStatus: 'RELEASED' })
    const res = await confirm(mission.id)

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'ESCROW_NOT_HELD' })
    expect(captureCalls).toHaveLength(0)
  })

  it('(D) IDOR : voyageur → 404, tiers → 404, non authentifié → 401, aucune capture', async () => {
    captureCalls.length = 0
    const mission = await seedDeposited()

    expect((await confirm(mission.id, bearer(travelerToken))).statusCode).toBe(404)
    expect((await confirm(mission.id, bearer(strangerToken))).statusCode).toBe(404)
    expect((await confirm(mission.id, {})).statusCode).toBe(401)
    expect(captureCalls).toHaveLength(0)

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DEPOSITED') // aucune écriture
  })

  it('(E) double confirmation → 400 INVALID_MISSION_STATE (2e appel)', async () => {
    captureCalls.length = 0
    const mission = await seedDeposited()

    const first = await confirm(mission.id)
    expect(first.statusCode).toBe(200)

    const second = await confirm(mission.id)
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'INVALID_MISSION_STATE' })

    // Capture une seule fois : le 2e appel s'arrête à la garde d'état (plus DEPOSITED).
    expect(captureCalls).toHaveLength(1)
  })

  const QR_RAW = 'WAYLO-INNER-SEAL-7F3A9C2E1B'

  it('(F) sceau présent + QR correct → 200 VALIDATED, capture 1× (chemin RELEASED existant)', async () => {
    captureCalls.length = 0
    const mission = await seedDeposited({ innerQrCodeHash: hashQrCode(QR_RAW) })
    const res = await confirmWithQr(mission.id, QR_RAW)

    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('VALIDATED')
    expect(captureCalls).toEqual([{ id: `pi_cc_${mission.id}`, key: `capture_collection_${mission.id}` }])
  })

  it('(G) sceau présent + QR faux OU absent → 400 INVALID_QR_PROOF, aucune capture, mission intacte', async () => {
    captureCalls.length = 0
    const mission = await seedDeposited({ innerQrCodeHash: hashQrCode(QR_RAW) })

    // QR faux : rejet AVANT toute capture.
    const wrong = await confirmWithQr(mission.id, 'MAUVAIS-CODE')
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json()).toEqual({ error: 'INVALID_QR_PROOF' })

    // QR absent (corps vide) sur une mission scellée → même rejet.
    const missing = await confirm(mission.id)
    expect(missing.statusCode).toBe(400)
    expect(missing.json()).toEqual({ error: 'INVALID_QR_PROOF' })

    expect(captureCalls).toHaveLength(0)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DEPOSITED') // séquestre jamais libéré sur preuve invalide
  })
})
