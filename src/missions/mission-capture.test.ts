import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission.route'

/**
 * Validation acheteur (T1) — POST /api/missions/:id/validate :
 * (1) acheteur, mission AWAITING_VALIDATION + escrow HELD → 200, mission VALIDATED,
 *     capture() appelée une fois avec idempotencyKey capture_<missionId> ;
 * (2) double validation → 400, capture() NON rappelée ;
 * (3) statut non-AWAITING_VALIDATION → 400 ; escrow non-HELD → 400 ;
 * (4) tiers / voyageur seul / inexistante → 404 ; non authentifié → 401.
 * Stripe entièrement mocké : aucun appel réseau, aucune écriture comptable ici.
 *
 * Prérequis : DATABASE_URL → base waylo_test (cf. webhook.idempotence.test.ts).
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

describe('Validation acheteur T1 — POST /api/missions/:id/validate', () => {
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
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.user.deleteMany()

    buyer = await prisma.user.create({ data: { email: 'buyer-capture@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-capture@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-capture@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const validate = (missionId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/missions/${missionId}/validate`, headers })

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
        targetProduct: 'Article à valider',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    const piId = `pi_validate_${mission.id}`
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

  it('(1) acheteur → 200, mission VALIDATED, capture() appelée une fois (idempotencyKey déterministe)', async () => {
    const { missionId, piId } = await seed()
    const before = captureCalls.length

    const res = await validate(missionId, bearer(buyerToken))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: missionId, status: 'VALIDATED' })

    // Capture déclenchée, du bon PI, idempotencyKey capture_<missionId>.
    expect(captureCalls.length).toBe(before + 1)
    expect(captureCalls.at(-1)).toEqual({ id: piId, idempotencyKey: `capture_${missionId}` })

    // AUCUNE écriture comptable ici : ledger vide, escrow toujours HELD (le webhook fera le reste).
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId } })
    expect(escrow.status).toBe('HELD')
    expect(await prisma.ledgerEntry.count({ where: { escrowId: escrow.id } })).toBe(0)
  })

  it('(2) double validation → 400, capture() non rappelée', async () => {
    const { missionId } = await seed()
    const first = await validate(missionId, bearer(buyerToken))
    expect(first.statusCode).toBe(200)

    const callsAfterFirst = captureCalls.length
    const second = await validate(missionId, bearer(buyerToken))
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
    // 2e validation rejetée AVANT l'appel Stripe (mission déjà VALIDATED).
    expect(captureCalls.length).toBe(callsAfterFirst)
  })

  it('(3) statut non-AWAITING_VALIDATION → 400 ; escrow non-HELD → 400', async () => {
    const notAwaiting = await seed({ status: 'FUNDED' })
    const r1 = await validate(notAwaiting.missionId, bearer(buyerToken))
    expect(r1.statusCode).toBe(400)
    expect(r1.json()).toEqual({ error: 'MISSION_NOT_AWAITING_VALIDATION' })

    const escrowReleased = await seed({ escrowStatus: 'RELEASED' })
    const r2 = await validate(escrowReleased.missionId, bearer(buyerToken))
    expect(r2.statusCode).toBe(400)
    expect(r2.json()).toEqual({ error: 'ESCROW_NOT_HELD' })
  })

  it('(4) tiers → 404 ; voyageur assigné → 404 ; inexistante → 404 ; non authentifié → 401', async () => {
    const { missionId } = await seed({ travelerId: traveler.id })
    const callsBefore = captureCalls.length

    const strangerRes = await validate(missionId, bearer(app.jwt.sign({ sub: stranger.id })))
    expect(strangerRes.statusCode).toBe(404)
    expect(strangerRes.json()).toEqual({ error: 'MISSION_NOT_FOUND' })

    // Le voyageur participe mais ne valide pas (acheteur seulement).
    const travelerRes = await validate(missionId, bearer(app.jwt.sign({ sub: traveler.id })))
    expect(travelerRes.statusCode).toBe(404)

    const missingRes = await validate('cmmissionintrouvable0', bearer(buyerToken))
    expect(missingRes.statusCode).toBe(404)

    const unauthRes = await validate(missionId)
    expect(unauthRes.statusCode).toBe(401)
    expect(unauthRes.json()).toEqual({ error: 'UNAUTHORIZED' })

    // Aucun de ces refus n'a touché Stripe.
    expect(captureCalls.length).toBe(callsBefore)
  })
})
