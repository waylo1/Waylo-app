import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission.route'
import { findMissionForBuyer, findMissionForParticipant } from './mission-access'

/**
 * API missions (2a) : création/consultation + autorisation par ressource.
 * - POST : auth → 201 buyerId=moi ; non-auth → 401 ; budget négatif / expiresAt
 *   passée / champ manquant → 400 ;
 * - GET /:id : acheteur voit, voyageur assigné voit, tiers → 404, non-auth → 401 ;
 * - GET liste : seulement mes missions (acheteur + voyageur) ;
 * - helper d'autorisation testé directement.
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

const futureISO = (days: number): string =>
  new Date(Date.now() + days * 24 * 3600 * 1000).toISOString()

const validBody = () => ({
  targetProduct: 'Sac introuvable en France',
  budgetCents: 10_000,
  commissionCents: 1_500,
  origin: 'Paris',
  destination: 'Tokyo',
  destinationCountry: 'JP',
  expiresAt: futureISO(7),
})

describe('API missions — création, consultation, autorisation par ressource', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let stranger: User
  let admin: User
  let buyerToken: string
  let travelerToken: string
  let strangerToken: string
  let adminToken: string
  let sharedMissionId: string

  // Espion Stripe : prouve qu'une route bloquée n'a jamais tenté de capture.
  const captureCalls: string[] = []
  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({
        id: `pi_mr_${params.metadata['missionId']}`,
        client_secret: 'secret',
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
    await prisma.user.deleteMany()

    buyer = await prisma.user.create({ data: { email: 'buyer-mission@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-mission@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-mission@test.waylo' } })
    admin = await prisma.user.create({ data: { email: 'admin-mission@test.waylo', isAdmin: true } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    strangerToken = app.jwt.sign({ sub: stranger.id })
    adminToken = app.jwt.sign({ sub: admin.id })

    // Mission partagée : buyer = acheteur, traveler = voyageur assigné.
    const shared = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        targetProduct: 'Article partagé',
        budgetCents: 20_000,
        commissionCents: 2_000,
        destination: 'Osaka',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    sharedMissionId = shared.id
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const postMission = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/missions', payload: body, headers })
  const getMission = (id: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/missions/${id}`, headers })
  const listMissions = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/missions', headers })

  // ── POST ────────────────────────────────────────────────────────────────
  it('POST authentifié → 201, buyerId = moi, statut CREATED, montants figés', async () => {
    const res = await postMission(validBody(), bearer(buyerToken))
    expect(res.statusCode).toBe(201)
    const m = res.json()
    expect(m).toMatchObject({
      buyerId: buyer.id,
      travelerId: null,
      status: 'CREATED',
      budgetCents: 10_000,
      commissionCents: 1_500,
      destination: 'Tokyo',
    })
    // Persistée avec le bon acheteur.
    const inDb = await prisma.mission.findUniqueOrThrow({ where: { id: m.id } })
    expect(inDb.buyerId).toBe(buyer.id)
  })

  it('POST non authentifié → 401 (corps valide)', async () => {
    const res = await postMission(validBody())
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' })
  })

  it('POST budget négatif → 400', async () => {
    const res = await postMission({ ...validBody(), budgetCents: -100 }, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  it('POST budget à zéro → 400 (budget > 0 exigé)', async () => {
    const res = await postMission({ ...validBody(), budgetCents: 0 }, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
  })

  it('POST expiresAt passée → 400 EXPIRES_AT_IN_PAST', async () => {
    const res = await postMission({ ...validBody(), expiresAt: futureISO(-1) }, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'EXPIRES_AT_IN_PAST' })
  })

  it('POST expiresAt non parsable → 400 INVALID_INPUT', async () => {
    const res = await postMission({ ...validBody(), expiresAt: 'pas-une-date' }, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  it('POST champ manquant (destination) → 400', async () => {
    const body = validBody() as Record<string, unknown>
    delete body.destination
    const res = await postMission(body, bearer(buyerToken))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  // ── GET /:id ────────────────────────────────────────────────────────────
  it('GET /:id — acheteur voit', async () => {
    const res = await getMission(sharedMissionId, bearer(buyerToken))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: sharedMissionId, buyerId: buyer.id })
  })

  it('GET /:id — voyageur assigné voit', async () => {
    const res = await getMission(sharedMissionId, bearer(travelerToken))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: sharedMissionId, travelerId: traveler.id })
  })

  it('GET /:id — tiers → 404 (ne révèle pas l’existence)', async () => {
    const res = await getMission(sharedMissionId, bearer(strangerToken))
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
  })

  it('GET /:id — mission inexistante → 404 (même réponse qu’un accès refusé)', async () => {
    const res = await getMission('cmnonexistentmission000', bearer(buyerToken))
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
  })

  it('GET /:id — non authentifié → 401', async () => {
    const res = await getMission(sharedMissionId)
    expect(res.statusCode).toBe(401)
  })

  // ── GET liste ───────────────────────────────────────────────────────────
  it('GET liste — uniquement mes missions (acheteur + voyageur), jamais celles des autres', async () => {
    // Mission du tiers, sans lien avec buyer/traveler.
    const strangerMission = await prisma.mission.create({
      data: {
        buyerId: stranger.id,
        targetProduct: 'Mission tierce',
        budgetCents: 5_000,
        commissionCents: 0,
        destination: 'Berlin',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    const asBuyer = await listMissions(bearer(buyerToken))
    expect(asBuyer.statusCode).toBe(200)
    const buyerList = asBuyer.json() as Array<{ id: string; buyerId: string; travelerId: string | null }>
    // Tout élément me concerne (acheteur ou voyageur), la mission partagée est là,
    // la mission du tiers ne l’est pas.
    expect(buyerList.every(m => m.buyerId === buyer.id || m.travelerId === buyer.id)).toBe(true)
    expect(buyerList.some(m => m.id === sharedMissionId)).toBe(true)
    expect(buyerList.some(m => m.id === strangerMission.id)).toBe(false)

    // Le voyageur voit la mission partagée (où il est assigné).
    const asTraveler = await listMissions(bearer(travelerToken))
    const travelerList = asTraveler.json() as Array<{ id: string }>
    expect(travelerList.some(m => m.id === sharedMissionId)).toBe(true)
    expect(travelerList.some(m => m.id === strangerMission.id)).toBe(false)

    // Le tiers ne voit QUE la sienne.
    const asStranger = await listMissions(bearer(strangerToken))
    const strangerList = asStranger.json() as Array<{ id: string }>
    expect(strangerList.some(m => m.id === strangerMission.id)).toBe(true)
    expect(strangerList.some(m => m.id === sharedMissionId)).toBe(false)
  })

  it('GET liste — non authentifié → 401', async () => {
    const res = await listMissions()
    expect(res.statusCode).toBe(401)
  })

  // ── Garde admin (isAdmin en base, D1) ─────────────────────────────────────
  describe('garde admin isAdmin — routes douane ops', () => {
    const customsPending = (headers: Record<string, string> = {}) =>
      app.inject({ method: 'GET', url: '/api/missions/customs-pending', headers })
    const customsApprove = (id: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: `/api/missions/${id}/customs-approve`, headers })
    const customsReject = (id: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: `/api/missions/${id}/customs-reject`, headers })

    it('utilisateur isAdmin: false → 403 sur les trois routes admin', async () => {
      // buyer/traveler/stranger sont tous isAdmin: false (défaut) — aucun ne franchit la garde.
      const pending = await customsPending(bearer(buyerToken))
      expect(pending.statusCode).toBe(403)
      expect(pending.json()).toEqual({ error: 'FORBIDDEN' })
      expect((await customsApprove(sharedMissionId, bearer(travelerToken))).statusCode).toBe(403)
      expect((await customsReject(sharedMissionId, bearer(strangerToken))).statusCode).toBe(403)
    })

    it('utilisateur isAdmin: true → franchit la garde (jamais 403)', async () => {
      // Contrôle positif : l'admin passe le 403. customs-pending répond 200 ;
      // approve sur une mission non-PENDING répond 400 (règle métier), pas 403 —
      // preuve que la garde discrimine bien sur isAdmin et non un refus global.
      expect((await customsPending(bearer(adminToken))).statusCode).toBe(200)
      const approve = await customsApprove(sharedMissionId, bearer(adminToken))
      expect(approve.statusCode).toBe(400)
      expect(approve.json()).toEqual({ error: 'MISSION_NOT_CUSTOMS_REVIEW' })
    })

    it('non authentifié → 401 (avant la garde admin)', async () => {
      expect((await customsPending()).statusCode).toBe(401)
      expect((await customsApprove(sharedMissionId)).statusCode).toBe(401)
    })
  })

  // ── Garde douane /validate (D4) ───────────────────────────────────────────
  describe('garde douane — POST /:id/validate bloqué en revue douanière', () => {
    const validate = (id: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: `/api/missions/${id}/validate`, headers })

    async function seedCustoms(status: 'ESCROW_LOCKED_CUSTOMS' | 'PENDING_CUSTOMS_REVIEW') {
      const mission = await prisma.mission.create({
        data: {
          buyerId: buyer.id,
          travelerId: traveler.id,
          status,
          targetProduct: 'Article en douane',
          budgetCents: 60_000,
          commissionCents: 6_000,
          destination: 'New York',
          destinationCountry: 'US',
          purchaseAmountCents: 60_000,
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      })
      // Escrow HELD : si la garde échouait, /validate tenterait la capture Stripe.
      await prisma.escrowTransaction.create({
        data: {
          missionId: mission.id,
          stripePaymentIntentId: `pi_mr_${mission.id}`,
          status: 'HELD',
          spendingLimitCents: 60_000,
          idempotencyKey: `escrow_fund_${mission.id}`,
        },
      })
      return mission.id
    }

    it('statuts douane → 409 CUSTOMS_REVIEW_PENDING, aucune capture Stripe', async () => {
      captureCalls.length = 0
      for (const status of ['ESCROW_LOCKED_CUSTOMS', 'PENDING_CUSTOMS_REVIEW'] as const) {
        const id = await seedCustoms(status)
        const res = await validate(id, bearer(buyerToken))
        expect(res.statusCode).toBe(409)
        expect(res.json()).toEqual({ error: 'CUSTOMS_REVIEW_PENDING' })
        // Le blocage est en lecture seule : statut inchangé.
        const db = await prisma.mission.findUniqueOrThrow({ where: { id } })
        expect(db.status).toBe(status)
      }
      // Aucune des deux requêtes n'a atteint Stripe (garde AVANT capture).
      expect(captureCalls).toHaveLength(0)
    })
  })

  // ── Helper d’autorisation (direct) ────────────────────────────────────────
  describe('findMissionForParticipant / findMissionForBuyer', () => {
    it('acheteur → relation buyer', async () => {
      const access = await findMissionForParticipant(prisma, sharedMissionId, buyer.id)
      expect(access?.relation).toBe('buyer')
      expect(access?.mission.id).toBe(sharedMissionId)
    })

    it('voyageur assigné → relation traveler', async () => {
      const access = await findMissionForParticipant(prisma, sharedMissionId, traveler.id)
      expect(access?.relation).toBe('traveler')
    })

    it('tiers → null', async () => {
      expect(await findMissionForParticipant(prisma, sharedMissionId, stranger.id)).toBeNull()
    })

    it('mission inexistante → null', async () => {
      expect(await findMissionForParticipant(prisma, 'cmnope000', buyer.id)).toBeNull()
    })

    it('findMissionForBuyer : acheteur → mission, voyageur/tiers → null', async () => {
      expect((await findMissionForBuyer(prisma, sharedMissionId, buyer.id))?.id).toBe(sharedMissionId)
      expect(await findMissionForBuyer(prisma, sharedMissionId, traveler.id)).toBeNull()
      expect(await findMissionForBuyer(prisma, sharedMissionId, stranger.id)).toBeNull()
    })
  })
})
