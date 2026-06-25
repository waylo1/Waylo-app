import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * Concurrence optimiste — `version` sur Mission.
 *
 * Couvre /validate et /confirm-receipt avec le champ optionnel `expectedVersion` :
 *
 * (1) version correcte         → 200 VALIDATED, version incrémentée, capture appelée ;
 * (2) version dépassée (stale) → 409 VERSION_CONFLICT + details, mission intacte, pas de capture ;
 * (3) sans expectedVersion     → 200 rétrocompat (comportement historique préservé) ;
 * (4) create                   → version = 0 dans la réponse ;
 * (5) confirm-receipt — mêmes invariants que /validate (version match, stale, absent).
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

describe('[SHARED-409] Concurrence optimiste — version + 409 VERSION_CONFLICT', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let buyerToken: string
  const captureCalls: Array<{ id: string; idempotencyKey: string }> = []

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
    await resetDb(prisma)

    buyer = await prisma.user.create({ data: { email: 'buyer-version@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  /** Mission AWAITING_VALIDATION + escrow HELD avec version choisie. */
  async function seed(versionOverride = 0): Promise<{ missionId: string; piId: string }> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'AWAITING_VALIDATION',
        targetProduct: 'Produit test concurrence',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        version: versionOverride,
      },
    })
    const piId = `pi_version_${mission.id}`
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: piId,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return { missionId: mission.id, piId }
  }

  // ── /validate ──────────────────────────────────────────────────────────────

  describe('/validate', () => {
    it('(1) version correcte → 200 VALIDATED, version incrémentée, capture appelée', async () => {
      const { missionId, piId } = await seed(0)
      const callsBefore = captureCalls.length

      const res = await app.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/validate`,
        headers: bearer(buyerToken),
        payload: { expectedVersion: 0 },
      })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toMatchObject({ id: missionId, status: 'VALIDATED', version: 1 })

      // Capture bien déclenchée avec la clé idempotente canonique.
      expect(captureCalls.length).toBe(callsBefore + 1)
      expect(captureCalls.at(-1)).toMatchObject({ id: piId, idempotencyKey: `capture_${missionId}` })
    })

    it('(2) version dépassée → 409, mission intacte, aucune capture', async () => {
      const { missionId } = await seed(3) // version DB = 3
      const callsBefore = captureCalls.length

      const res = await app.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/validate`,
        headers: bearer(buyerToken),
        payload: { expectedVersion: 1 }, // client croit être à 1
      })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: 'VERSION_CONFLICT',
        details: { currentVersion: 3, expectedVersion: 1 },
      })

      // Aucune capture Stripe émise — fail-fast avant appel réseau.
      expect(captureCalls.length).toBe(callsBefore)

      // Mission intacte : statut et version inchangés.
      const db = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
      expect(db.status).toBe('AWAITING_VALIDATION')
      expect(db.version).toBe(3)
    })

    it('(3) sans expectedVersion → 200 rétrocompat, version incrémentée', async () => {
      const { missionId } = await seed(0)

      const res = await app.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/validate`,
        headers: bearer(buyerToken),
        // Pas de body — comportement historique préservé.
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'VALIDATED', version: 1 })
    })

    it('(4) create renvoie version = 0', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/missions',
        headers: bearer(buyerToken),
        payload: {
          targetProduct: 'Produit check version',
          budgetCents: 5_000,
          commissionCents: 500,
          origin: 'Paris',
          destination: 'Tokyo',
          destinationCountry: 'JP',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
        },
      })

      expect(res.statusCode).toBe(201)
      expect(res.json()).toMatchObject({ version: 0 })
    })
  })

  // ── /confirm-receipt ────────────────────────────────────────────────────────

  describe('/confirm-receipt', () => {
    it('(5a) version correcte → 200 VALIDATED, version incrémentée', async () => {
      const { missionId } = await seed(2)
      const callsBefore = captureCalls.length

      const res = await app.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/confirm-receipt`,
        headers: bearer(buyerToken),
        payload: { expectedVersion: 2 },
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'VALIDATED', version: 3 })
      expect(captureCalls.length).toBe(callsBefore + 1)
    })

    it('(5b) version dépassée → 409, mission intacte, aucune capture', async () => {
      const { missionId } = await seed(5)
      const callsBefore = captureCalls.length

      const res = await app.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/confirm-receipt`,
        headers: bearer(buyerToken),
        payload: { expectedVersion: 2 },
      })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: 'VERSION_CONFLICT',
        details: { currentVersion: 5, expectedVersion: 2 },
      })
      expect(captureCalls.length).toBe(callsBefore)

      const db = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
      expect(db.status).toBe('AWAITING_VALIDATION')
      expect(db.version).toBe(5)
    })

    it('(5c) sans expectedVersion → 200 rétrocompat', async () => {
      const { missionId } = await seed(0)

      const res = await app.inject({
        method: 'POST',
        url: `/api/missions/${missionId}/confirm-receipt`,
        headers: bearer(buyerToken),
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'VALIDATED', version: 1 })
    })
  })
})
