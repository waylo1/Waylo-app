import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'

/**
 * Financement T0 (2b) — POST /api/missions/:id/intent :
 * (1) acheteur → 200 + client_secret ; escrow HELD + mission FUNDED en DB ;
 *     PI créé en capture différée avec idempotencyKey déterministe ;
 * (2) tiers / voyageur / mission inexistante → 404 ; non authentifié → 401 ;
 * (3) déjà financée → 400, et Stripe N'EST PAS rappelé ;
 * (4) statut non-CREATED → 400 MISSION_NOT_FUNDABLE.
 * Stripe entièrement mocké : aucun appel réseau.
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
const TOTAL_CENTS = BUDGET_CENTS + COMMISSION_CENTS

interface RecordedIntentCall {
  amount: number
  currency: string
  capture_method: string
  metadata: Record<string, string>
  idempotencyKey: string
}

describe('Financement T0 — POST /api/missions/:id/intent', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let stranger: User
  let buyerToken: string
  const intentCalls: RecordedIntentCall[] = []

  // Bascule de panne : quand vrai, l'appel Stripe échoue (coupure réseau simulée).
  let stripeFailMode = false

  // Fake Stripe : enregistre chaque appel, rend un PI déterministe par mission.
  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params, options) => {
        if (stripeFailMode) {
          // Timeout artificiel AVANT toute réponse Stripe, puis échec réseau.
          await new Promise(resolve => setTimeout(resolve, 5))
          throw new Error('SIMULATED_NETWORK_OUTAGE')
        }
        intentCalls.push({ ...params, idempotencyKey: options.idempotencyKey })
        return {
          id: `pi_fake_${params.metadata['missionId']}`,
          client_secret: `pi_fake_${params.metadata['missionId']}_secret_test`,
        }
      },
      // Non sollicité par le financement T0 — présent pour satisfaire l'interface.
      capture: async id => ({ id }),
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })

    await prisma.walletTransaction.deleteMany()
    await prisma.wallet.deleteMany() // FK userId RESTRICT : purger AVANT user.deleteMany()
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

    buyer = await prisma.user.create({ data: { email: 'buyer-funding@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-funding@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-funding@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const fund = (missionId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: `/api/missions/${missionId}/intent`, headers })
  // Variante avec corps (capacité carte déclarée) — garde capacité « Drive » S19.
  const fundBody = (
    missionId: string,
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ) => app.inject({ method: 'POST', url: `/api/missions/${missionId}/intent`, headers, payload })

  // total = budget + commission = 11_500 → plafond capacité requis (120%) = 13_800.
  const REQUIRED_CAPACITY_CENTS = Math.floor((TOTAL_CENTS * 12) / 10)

  const seedMission = (overrides: { travelerId?: string; status?: 'CREATED' | 'MATCHED' } = {}) =>
    prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: overrides.travelerId ?? null,
        status: overrides.status ?? 'CREATED',
        targetProduct: 'Article à financer',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

  it('(1) acheteur → 200 + client_secret ; escrow HELD, mission FUNDED, PI séquestre', async () => {
    const mission = await seedMission()
    const res = await fund(mission.id, bearer(buyerToken))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      clientSecret: `pi_fake_${mission.id}_secret_test`,
      paymentIntentId: `pi_fake_${mission.id}`,
      amountCents: TOTAL_CENTS,
    })

    // Le PI est créé en capture DIFFÉRÉE, au bon montant, idempotencyKey déterministe.
    expect(intentCalls).toHaveLength(1)
    expect(intentCalls[0]).toEqual({
      amount: TOTAL_CENTS, // budget + commission (la commission est le frais plateforme)
      currency: 'eur',
      capture_method: 'manual',
      metadata: { missionId: mission.id },
      idempotencyKey: `fund_${mission.id}`,
    })

    // T0 en DB : escrow HELD, rien capturé, plafond JIT = budget ; mission FUNDED.
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({
      where: { missionId: mission.id },
    })
    expect(escrow).toMatchObject({
      stripePaymentIntentId: `pi_fake_${mission.id}`,
      status: 'HELD',
      capturedAmountCents: 0,
      spendingLimitCents: BUDGET_CENTS,
      idempotencyKey: `escrow_fund_${mission.id}`,
    })
    const after = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(after.status).toBe('FUNDED')
    // Aucune écriture comptable à T0 : le ledger ne bouge qu'à la capture.
    expect(await prisma.ledgerEntry.count({ where: { escrowId: escrow.id } })).toBe(0)
  })

  it('(2) déjà financée → 400 MISSION_ALREADY_FUNDED, Stripe non rappelé', async () => {
    const callsBefore = intentCalls.length
    // La mission du test (1) est FUNDED avec escrow : on retente.
    const funded = await prisma.mission.findFirstOrThrow({ where: { status: 'FUNDED' } })
    const res = await fund(funded.id, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_ALREADY_FUNDED' })
    expect(intentCalls).toHaveLength(callsBefore) // précondition vérifiée AVANT l'appel Stripe
    // Toujours un seul escrow.
    expect(await prisma.escrowTransaction.count({ where: { missionId: funded.id } })).toBe(1)
  })

  it('(3) statut non-CREATED (MATCHED, sans escrow) → 400 MISSION_NOT_FUNDABLE', async () => {
    const matched = await seedMission({ status: 'MATCHED' })
    const res = await fund(matched.id, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FUNDABLE' })
  })

  it('(4) tiers → 404 ; voyageur assigné → 404 (acheteur seulement) ; inexistante → 404', async () => {
    const mission = await seedMission({ travelerId: traveler.id })
    const strangerRes = await fund(mission.id, bearer(app.jwt.sign({ sub: stranger.id })))
    expect(strangerRes.statusCode).toBe(404)
    expect(strangerRes.json()).toEqual({ error: 'MISSION_NOT_FOUND' })

    // Le voyageur participe à la mission mais ne peut PAS la financer.
    const travelerRes = await fund(mission.id, bearer(app.jwt.sign({ sub: traveler.id })))
    expect(travelerRes.statusCode).toBe(404)

    const missingRes = await fund('cmmissionintrouvable0', bearer(buyerToken))
    expect(missingRes.statusCode).toBe(404)

    // Aucun de ces refus n'a touché Stripe ni créé d'escrow.
    expect(await prisma.escrowTransaction.count({ where: { missionId: mission.id } })).toBe(0)
  })

  it('(5) non authentifié → 401', async () => {
    const mission = await seedMission()
    const res = await fund(mission.id)
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' })
  })

  it('(6) deux /intent SIMULTANÉS sur le même panier → un seul PI, un seul escrow', async () => {
    const mission = await seedMission()
    const before = intentCalls.filter(c => c.metadata['missionId'] === mission.id).length

    // Deux financements concurrents de la MÊME mission (idempotence sous course).
    const [a, b] = await Promise.all([
      fund(mission.id, bearer(buyerToken)),
      fund(mission.id, bearer(buyerToken)),
    ])

    // Exactement un succès, un refus idempotent (réservation atomique CREATED→FUNDED).
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400])
    const refused = a.statusCode === 400 ? a : b
    expect(refused.json()).toEqual({ error: 'MISSION_ALREADY_FUNDED' })

    // Le perdant échoue AVANT l'appel Stripe : UN SEUL PaymentIntent créé.
    const after = intentCalls.filter(c => c.metadata['missionId'] === mission.id).length
    expect(after - before).toBe(1)

    // Un seul escrow, mission FUNDED.
    expect(await prisma.escrowTransaction.count({ where: { missionId: mission.id } })).toBe(1)
    expect(
      (await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })).status,
    ).toBe('FUNDED')
  })

  it('(7) échec Stripe (coupure réseau) → rollback DB : mission CREATED, aucun escrow', async () => {
    const mission = await seedMission()

    stripeFailMode = true
    try {
      const res = await fund(mission.id, bearer(buyerToken))
      // L'erreur Stripe propage après rollback → 500 (gestionnaire d'erreurs route).
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'INTERNAL_ERROR' })
    } finally {
      stripeFailMode = false
    }

    // Réservation RELÂCHÉE : mission de retour CREATED, aucun escrow committé.
    expect(
      (await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })).status,
    ).toBe('CREATED')
    expect(await prisma.escrowTransaction.count({ where: { missionId: mission.id } })).toBe(0)

    // Re-finançable : un nouvel essai (Stripe rétabli) aboutit normalement.
    const retry = await fund(mission.id, bearer(buyerToken))
    expect(retry.statusCode).toBe(200)
    expect(await prisma.escrowTransaction.count({ where: { missionId: mission.id } })).toBe(1)
    expect(
      (await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })).status,
    ).toBe('FUNDED')
  })

  it('(8) capacité carte déclarée < 120% du total, sans Wallet → 400 INSUFFICIENT_FUNDS_FOR_MISSION (Stripe non rappelé)', async () => {
    const mission = await seedMission()
    const callsBefore = intentCalls.length

    // Carte 10_000 + Wallet 0 = 10_000 < 13_800 (plafond 120%).
    const res = await fundBody(mission.id, bearer(buyerToken), {
      stripeAuthorizationCents: REQUIRED_CAPACITY_CENTS - 3_800, // 10_000
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INSUFFICIENT_FUNDS_FOR_MISSION' })

    // Bloqué AVANT la réservation ET l'appel Stripe : rien n'a bougé.
    expect(intentCalls).toHaveLength(callsBefore)
    expect(await prisma.escrowTransaction.count({ where: { missionId: mission.id } })).toBe(0)
    expect(
      (await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })).status,
    ).toBe('CREATED')
  })

  it('(9) le Wallet interne comble le delta → 200, mission FUNDED (hold inchangé = budget + commission)', async () => {
    const mission = await seedMission()
    // Carte 10_000 + Wallet 4_000 = 14_000 ≥ 13_800 → la garde passe grâce au Wallet.
    await prisma.wallet.create({ data: { userId: buyer.id, balanceCents: 4_000 } })
    try {
      const res = await fundBody(mission.id, bearer(buyerToken), {
        stripeAuthorizationCents: REQUIRED_CAPACITY_CENTS - 3_800, // 10_000
      })

      expect(res.statusCode).toBe(200)
      // La garde NE redimensionne PAS le séquestre : hold = budget + commission.
      expect(res.json()).toMatchObject({ amountCents: TOTAL_CENTS })
      expect(await prisma.escrowTransaction.count({ where: { missionId: mission.id } })).toBe(1)
      expect(
        (await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })).status,
      ).toBe('FUNDED')
    } finally {
      await prisma.wallet.deleteMany({ where: { userId: buyer.id } })
    }
  })
})
