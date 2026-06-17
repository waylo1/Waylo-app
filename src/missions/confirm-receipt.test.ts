import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission.route'

/**
 * Confirmation de réception acheteur — POST /api/missions/:id/confirm-receipt.
 *
 * JUMEAU architectural de /validate : déclenche la CAPTURE du séquestre, jamais
 * le versement. Les écritures ledger PAYOUT/COMMISSION, le TransferOutbox et le
 * passage RELEASED sont portés par le webhook payment_intent.succeeded (couvert
 * par les tests webhook) — JAMAIS dupliqués dans la route (règle d'or §5,
 * invariants ledger §3). On vérifie donc ici : capture appelée + VALIDATED +
 * AUCUNE écriture comptable côté route.
 *
 * (1) acheteur, AWAITING_VALIDATION + escrow HELD → 200, VALIDATED, capture
 *     `capture_<id>` appelée une fois, ledger vide / escrow toujours HELD ;
 * (2) voyageur assigné → 404 (invariant IDOR, indistinguable d'un tiers) ;
 * (3) statut non-AWAITING_VALIDATION → 400 ; escrow non-HELD → 400 ;
 *     double confirmation → 400 sans re-capture.
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

describe('Confirmation réception acheteur — POST /api/missions/:id/confirm-receipt', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let stranger: User
  let buyerToken: string
  const captureCalls: Array<{ id: string; idempotencyKey: string }> = []

  // Fake Stripe : create (financement) + capture (T1). Enregistre les captures.
  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({
        id: `pi_fake_${params.metadata['missionId']}`,
        client_secret: 'secret_test',
      }),
      capture: async (id, _params, options) => {
        captureCalls.push({ id, idempotencyKey: options.idempotencyKey })
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
    await prisma.review.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.user.deleteMany()

    buyer = await prisma.user.create({ data: { email: 'buyer-confirm@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-confirm@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-confirm@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const confirmReceipt = (missionId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/missions/${missionId}/confirm-receipt`, headers })

  /** Mission + escrow HELD à un statut donné. PI déterministe par mission. */
  async function seed(opts: {
    status?: 'AWAITING_VALIDATION' | 'FUNDED'
    escrowStatus?: 'HELD' | 'RELEASED'
    travelerId?: string
  } = {}): Promise<{ missionId: string; piId: string }> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: opts.travelerId ?? null,
        status: opts.status ?? 'AWAITING_VALIDATION',
        targetProduct: 'Article à confirmer',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    const piId = `pi_confirm_${mission.id}`
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: piId,
        status: opts.escrowStatus ?? 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return { missionId: mission.id, piId }
  }

  it('(1) acheteur → 200 VALIDATED, capture `capture_<id>` une fois, AUCUNE écriture comptable (déléguée au webhook)', async () => {
    const { missionId, piId } = await seed()
    const before = captureCalls.length

    const res = await confirmReceipt(missionId, bearer(buyerToken))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: missionId, status: 'VALIDATED' })

    // Capture déclenchée, du bon PI, clé partagée capture_<missionId>.
    expect(captureCalls.length).toBe(before + 1)
    expect(captureCalls.at(-1)).toEqual({ id: piId, idempotencyKey: `capture_${missionId}` })

    // Frontière webhook : ledger vide, escrow toujours HELD. Le passage RELEASED
    // + PAYOUT/COMMISSION + TransferOutbox sont portés par payment_intent.succeeded.
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId } })
    expect(escrow.status).toBe('HELD')
    expect(await prisma.ledgerEntry.count({ where: { escrowId: escrow.id } })).toBe(0)
  })

  it('(2) voyageur assigné → 404 MISSION_NOT_FOUND (invariant IDOR) ; aucun appel Stripe', async () => {
    const { missionId } = await seed({ travelerId: traveler.id })
    const callsBefore = captureCalls.length

    // Le voyageur participe mais ne confirme pas (acheteur seulement) — 404 masquant.
    const travelerRes = await confirmReceipt(missionId, bearer(app.jwt.sign({ sub: traveler.id })))
    expect(travelerRes.statusCode).toBe(404)
    expect(travelerRes.json()).toEqual({ error: 'MISSION_NOT_FOUND' })

    // Tiers et non authentifié, même invariant.
    const strangerRes = await confirmReceipt(missionId, bearer(app.jwt.sign({ sub: stranger.id })))
    expect(strangerRes.statusCode).toBe(404)
    const unauthRes = await confirmReceipt(missionId)
    expect(unauthRes.statusCode).toBe(401)
    expect(unauthRes.json()).toEqual({ error: 'UNAUTHORIZED' })

    // Aucun refus n'a touché Stripe, mission intacte.
    expect(captureCalls.length).toBe(callsBefore)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(db.status).toBe('AWAITING_VALIDATION')
  })

  it('(3) statut non-AWAITING → 400 ; escrow non-HELD → 400 ; double confirmation → 400 sans re-capture', async () => {
    const notAwaiting = await seed({ status: 'FUNDED' })
    const r1 = await confirmReceipt(notAwaiting.missionId, bearer(buyerToken))
    expect(r1.statusCode).toBe(400)
    expect(r1.json()).toEqual({ error: 'MISSION_NOT_AWAITING_VALIDATION' })

    const escrowReleased = await seed({ escrowStatus: 'RELEASED' })
    const r2 = await confirmReceipt(escrowReleased.missionId, bearer(buyerToken))
    expect(r2.statusCode).toBe(400)
    expect(r2.json()).toEqual({ error: 'ESCROW_NOT_HELD' })

    // Double confirmation : la 1re a posé VALIDATED, la 2e est rejetée AVANT Stripe.
    const dbl = await seed()
    expect((await confirmReceipt(dbl.missionId, bearer(buyerToken))).statusCode).toBe(200)
    const callsAfterFirst = captureCalls.length
    const second = await confirmReceipt(dbl.missionId, bearer(buyerToken))
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
    expect(captureCalls.length).toBe(callsAfterFirst)
  })
})
