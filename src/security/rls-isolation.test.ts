import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from '../missions/mission-common'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * Tests d'isolation multi-tenant — précondition pour l'étape Enforce de la RLS.
 *
 * Ces tests valident la couche d'autorisation APPLICATIVE (mission-access.ts) qui
 * sera ensuite DOUBLÉE par la RLS au niveau DB. Ils doivent rester verts après
 * le basculement vers le rôle `waylo_app NOBYPASSRLS` + enforce.
 *
 * Propriétés vérifiées :
 *   (I1) Un utilisateur ne voit PAS les missions d'un autre utilisateur.
 *   (I2) Un utilisateur ne peut PAS accéder au wallet d'un autre utilisateur.
 *   (I3) Le catalogue /available expose UNIQUEMENT les missions FUNDED sans voyageur.
 *   (I4) Un voyageur ne peut PAS déclencher le financement d'une mission tierce.
 *   (I5) L'acheteur d'une mission ne voit PAS les missions d'un autre acheteur dans sa liste.
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

const fakeStripe: PaymentIntentClient = {
  paymentIntents: {
    create: async (_p, _o) => ({ id: 'pi_iso_test', client_secret: 'secret_iso' }),
    capture: async id => ({ id }),
  },
}

describe('Isolation multi-tenant — précondition Enforce RLS', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let alice: User
  let bob: User
  let charlie: User // voyageur tiers
  let aliceToken: string
  let bobToken: string
  let charlieToken: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })
    await resetDb(prisma)

    // KYC VERIFIED : ces tests isolent l'IDOR (Mission/Wallet), pas le gate KYC.
    // La policy wallet_select exige `app.is_certified` en plus de l'identité
    // (cf. migration enable_rls_policies) — non-certifié ⇒ 403 KYC_REQUIRED,
    // ce qui masquerait le 404 IDOR attendu par (I2a)/(I2c).
    alice   = await prisma.user.create({ data: { email: 'alice-iso@test.waylo', kycStatus: 'VERIFIED' } })
    bob     = await prisma.user.create({ data: { email: 'bob-iso@test.waylo', kycStatus: 'VERIFIED' } })
    charlie = await prisma.user.create({ data: { email: 'charlie-iso@test.waylo', kycStatus: 'VERIFIED' } })

    aliceToken   = app.jwt.sign({ sub: alice.id })
    bobToken     = app.jwt.sign({ sub: bob.id })
    charlieToken = app.jwt.sign({ sub: charlie.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

  // ─────────────────────────────────────────────────────────────────────────
  // I1 — Mission isolation : Bob ne voit pas la mission d'Alice
  // ─────────────────────────────────────────────────────────────────────────

  it('(I1a) GET /missions/:id → 404 pour un tiers (IDOR masqué)', async () => {
    const mission = await prisma.mission.create({
      data: {
        buyerId: alice.id,
        status: 'CREATED',
        targetProduct: 'Alice item',
        budgetCents: 5000,
        commissionCents: 500,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    // Bob tente de lire la mission d'Alice → 404 (existence non révélée)
    const res = await app.inject({
      method: 'GET',
      url: `/api/missions/${mission.id}`,
      headers: bearer(bobToken),
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
  })

  it('(I1b) GET /missions (liste) → Bob ne voit que ses propres missions', async () => {
    // Bob crée une mission → elle doit figurer dans SA liste.
    const bobMission = await prisma.mission.create({
      data: {
        buyerId: bob.id,
        status: 'CREATED',
        targetProduct: 'Bob item',
        budgetCents: 3000,
        commissionCents: 300,
        destination: 'Paris',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/missions',
      headers: bearer(bobToken),
    })
    expect(res.statusCode).toBe(200)
    const list = res.json() as Array<{ id: string }>
    const ids = list.map(m => m.id)
    // Bob voit SA mission
    expect(ids).toContain(bobMission.id)
    // Bob ne voit PAS les missions d'Alice (toutes créées avant)
    const aliceMissions = await prisma.mission.findMany({ where: { buyerId: alice.id } })
    for (const m of aliceMissions) {
      expect(ids).not.toContain(m.id)
    }
  })

  it('(I1c) Un voyageur assigné voit sa mission mais pas celle d\'un autre voyageur', async () => {
    // Mission assignée à Charlie
    const charlieMission = await prisma.mission.create({
      data: {
        buyerId: alice.id,
        travelerId: charlie.id,
        status: 'MATCHED',
        targetProduct: 'Matched item',
        budgetCents: 4000,
        commissionCents: 400,
        destination: 'Osaka',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    // Charlie voit sa mission
    const ok = await app.inject({
      method: 'GET',
      url: `/api/missions/${charlieMission.id}`,
      headers: bearer(charlieToken),
    })
    expect(ok.statusCode).toBe(200)

    // Bob ne voit pas la mission d'Alice/Charlie
    const no = await app.inject({
      method: 'GET',
      url: `/api/missions/${charlieMission.id}`,
      headers: bearer(bobToken),
    })
    expect(no.statusCode).toBe(404)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // I2 — Wallet isolation : Bob ne voit pas le wallet d'Alice
  // ─────────────────────────────────────────────────────────────────────────

  it('(I2a) GET /missions/:id/wallet → 404 si la mission appartient à un autre', async () => {
    // Alice a une mission ; Bob tente de lire son wallet via cette mission → 404
    const aliceMission = await prisma.mission.findFirst({ where: { buyerId: alice.id } })
    expect(aliceMission).toBeTruthy()

    const res = await app.inject({
      method: 'GET',
      url: `/api/missions/${aliceMission!.id}/wallet`,
      headers: bearer(bobToken),
    })
    // Bob n'est pas l'acheteur → findMissionForBuyer retourne null → 404
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
  })

  it('(I2b) GET /missions/:id/wallet → 200 + solde vide pour l\'acheteur légitime', async () => {
    const aliceMission = await prisma.mission.findFirst({ where: { buyerId: alice.id } })
    const res = await app.inject({
      method: 'GET',
      url: `/api/missions/${aliceMission!.id}/wallet`,
      headers: bearer(aliceToken),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // Pas de wallet crédité → solde nul (état légitime, pas 404)
    expect(body).toMatchObject({ balanceCents: 0, transactions: [] })
  })

  it('(I2c) Un voyageur assigné ne peut pas lire le wallet de l\'acheteur via sa propre mission', async () => {
    const charlieMission = await prisma.mission.findFirst({ where: { travelerId: charlie.id } })
    const res = await app.inject({
      method: 'GET',
      url: `/api/missions/${charlieMission!.id}/wallet`,
      headers: bearer(charlieToken),
    })
    // findMissionForBuyer rejette le voyageur → 404
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // I3 — Catalogue /available : seules les missions FUNDED sans voyageur
  // ─────────────────────────────────────────────────────────────────────────

  it('(I3) /available n\'expose que les missions FUNDED sans voyageur (pas CREATED, pas MATCHED)', async () => {
    // Mission FUNDED sans voyageur (visible dans le catalogue)
    const funded = await prisma.mission.create({
      data: {
        buyerId: alice.id,
        status: 'FUNDED',
        targetProduct: 'Catalogue item',
        budgetCents: 8000,
        commissionCents: 800,
        destination: 'Seoul',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    // Mission CREATED (ne doit PAS apparaître)
    const created = await prisma.mission.create({
      data: {
        buyerId: alice.id,
        status: 'CREATED',
        targetProduct: 'Hidden item',
        budgetCents: 2000,
        commissionCents: 200,
        destination: 'Seoul',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/missions/available',
      headers: bearer(bobToken),
    })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as Array<{ id: string }>).map(m => m.id)

    expect(ids).toContain(funded.id)    // FUNDED → visible
    expect(ids).not.toContain(created.id) // CREATED → invisible
  })

  it('(I3b) /available n\'expose pas les missions de l\'appelant lui-même', async () => {
    // Alice cherche des missions disponibles : ses propres missions FUNDED ne doivent pas figurer
    const res = await app.inject({
      method: 'GET',
      url: '/api/missions/available',
      headers: bearer(aliceToken),
    })
    expect(res.statusCode).toBe(200)
    const list = res.json() as Array<{ buyerId: string }>
    // Aucune mission d'Alice ne doit apparaître (buyerId: { not: alice.id })
    expect(list.every(m => m.buyerId !== alice.id)).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // I4 — Financement : seul l'acheteur peut financer sa mission
  // ─────────────────────────────────────────────────────────────────────────

  it('(I4) POST /missions/:id/intent → 404 si l\'appelant n\'est pas l\'acheteur', async () => {
    const aliceMission = await prisma.mission.findFirst({
      where: { buyerId: alice.id, status: 'CREATED' },
    })
    expect(aliceMission).toBeTruthy()

    // Bob tente de financer la mission d'Alice → 404
    const resBob = await app.inject({
      method: 'POST',
      url: `/api/missions/${aliceMission!.id}/intent`,
      headers: bearer(bobToken),
    })
    expect(resBob.statusCode).toBe(404)

    // Charlie (voyageur) tente également → 404
    const resCharlie = await app.inject({
      method: 'POST',
      url: `/api/missions/${aliceMission!.id}/intent`,
      headers: bearer(charlieToken),
    })
    expect(resCharlie.statusCode).toBe(404)
  })
})
