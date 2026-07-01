import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * GET /api/missions/:id/wallet — vue Wallet acheteur (solde + historique) :
 * (A) l'acheteur voit son solde et ses mouvements (les plus récents d'abord) ;
 * (B) acheteur sans wallet crédité → 200 { balanceCents: 0, transactions: [] } ;
 * (C) un voyageur/tiers → 404 masquant (IDOR) ; non authentifié → 401 ;
 * (D) la réponse n'expose aucun champ interne (walletId/userId/updatedAt).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('GET /api/missions/:id/wallet', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let buyerNoWallet: User
  let traveler: User
  let outsider: User
  let buyerToken: string
  let buyerNoWalletToken: string
  let travelerToken: string
  let outsiderToken: string

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({
        id: `pi_w_${params.metadata['missionId']}`,
        client_secret: 'secret',
      }),
      capture: async (id) => ({ id }),
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })

    await resetDb(prisma)

    // KYC VERIFIED : la policy RLS wallet_select exige `app.is_certified` en
    // plus de l'identité (niveau bancaire) — non-certifié ⇒ 403 KYC_REQUIRED,
    // ce qui masquerait les 404 IDOR / 200 attendus par ces tests d'isolation.
    buyer = await prisma.user.create({ data: { email: 'buyer-w@test.waylo', kycStatus: 'VERIFIED' } })
    buyerNoWallet = await prisma.user.create({ data: { email: 'buyer-now@test.waylo', kycStatus: 'VERIFIED' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-w@test.waylo', kycStatus: 'VERIFIED' } })
    outsider = await prisma.user.create({ data: { email: 'outsider-w@test.waylo', kycStatus: 'VERIFIED' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    buyerNoWalletToken = app.jwt.sign({ sub: buyerNoWallet.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    outsiderToken = app.jwt.sign({ sub: outsider.id })
  })

  afterAll(async () => {
    // Purge FK-safe complète avant déconnexion : ne jamais laisser de wallet
    // derrière soi (FK `Wallet_userId_fkey` casserait la suite suivante).
    await resetDb(prisma)
    await app.close()
    await prisma.$disconnect()
  })

  const get = (missionId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/missions/${missionId}/wallet`, headers })
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  function seedMission(buyerId: string, travelerId: string | null = null) {
    return prisma.mission.create({
      data: {
        buyerId,
        travelerId,
        status: 'DEPOSITED',
        targetProduct: 'Article test',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        destinationCountry: 'JP',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  it('(A) l’acheteur voit son solde et ses mouvements (récents d’abord)', async () => {
    const m1 = await seedMission(buyer.id, traveler.id)
    const m2 = await seedMission(buyer.id, traveler.id)
    const wallet = await prisma.wallet.create({ data: { userId: buyer.id, balanceCents: 12_500 } })
    // Deux mouvements : m1 puis m2 (m2 le plus récent).
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, missionId: m1.id, amountCents: 5_000, reason: 'SUBSTITUTION_RESIDUAL' },
    })
    await prisma.walletTransaction.create({
      data: { walletId: wallet.id, missionId: m2.id, amountCents: 7_500, reason: 'SUBSTITUTION_RESIDUAL' },
    })

    const res = await get(m1.id, bearer(buyerToken))
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      balanceCents: number
      transactions: Array<{ missionId: string; amountCents: number; reason: string }>
    }
    expect(body.balanceCents).toBe(12_500)
    expect(body.transactions).toHaveLength(2)
    // Ordre desc par createdAt : m2 (le plus récent) en tête.
    expect(body.transactions[0].missionId).toBe(m2.id)
    expect(body.transactions[1].missionId).toBe(m1.id)
    expect(body.transactions[0].amountCents).toBe(7_500)
  })

  it('(B) acheteur sans wallet → 200 solde 0, historique vide', async () => {
    const m = await seedMission(buyerNoWallet.id)
    const res = await get(m.id, bearer(buyerNoWalletToken))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ balanceCents: 0, transactions: [] })
  })

  it('(C) voyageur/tiers → 404 masquant ; non authentifié → 401', async () => {
    const m = await seedMission(buyer.id, traveler.id)

    const asTraveler = await get(m.id, bearer(travelerToken))
    expect(asTraveler.statusCode).toBe(404)
    expect(asTraveler.json()).toEqual({ error: 'MISSION_NOT_FOUND' })

    const asOutsider = await get(m.id, bearer(outsiderToken))
    expect(asOutsider.statusCode).toBe(404)

    const unauth = await get(m.id)
    expect(unauth.statusCode).toBe(401)
    expect(unauth.json()).toEqual({ error: 'UNAUTHORIZED' })
  })

  it('(D) la réponse n’expose aucun champ interne du wallet', async () => {
    const m = await seedMission(buyer.id, traveler.id)
    const res = await get(m.id, bearer(buyerToken))
    expect(res.statusCode).toBe(200)
    const raw = res.json() as Record<string, unknown>
    expect(raw).not.toHaveProperty('userId')
    expect(raw).not.toHaveProperty('id')
    expect(raw).not.toHaveProperty('updatedAt')
    const tx = (raw.transactions as Array<Record<string, unknown>>)[0]
    expect(tx).not.toHaveProperty('walletId')
  })
})
