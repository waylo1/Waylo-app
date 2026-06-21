import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * Régression sécurité (Audit VULN #1/#2) — montant de capture EXPLICITE.
 *
 * Tous les chemins de capture passent désormais par captureEscrowFunds, qui envoie
 * un `amount_to_capture` exact = montant métier autorisé :
 *   - mission standard           → budget + commission ;
 *   - mission substitution Drive → floor(budget × 1,2) + commission (S17/S18).
 *
 * On vérifie le montant transmis à Stripe (fake) pour /validate (standard +
 * substitution) et /confirm-collection (substitution + clé dédiée).
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

const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500
const STANDARD_CAPTURE = BUDGET_CENTS + COMMISSION_CENTS // 11_500
const SUBSTITUTION_CAPTURE = Math.floor((BUDGET_CENTS * 12) / 10) + COMMISSION_CENTS // 13_500

interface CaptureCall {
  id: string
  key: string
  amount: number | undefined
}

describe('Capture — amount_to_capture explicite (Audit VULN #1/#2)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let buyerToken: string
  const captures: CaptureCall[] = []

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async params => ({
        id: `pi_${params.metadata['missionId']}`,
        client_secret: 'secret',
      }),
      capture: async (id, params, options) => {
        captures.push({ id, key: options.idempotencyKey, amount: params.amount_to_capture })
        return { id }
      },
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-capture-amount@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (): Record<string, string> => ({ authorization: `Bearer ${buyerToken}` })

  /** Mission + escrow HELD ; statut & substitution paramétrables. PI déterministe. */
  async function seed(opts: { status: string; substitutionAuthorized?: boolean }): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: opts.status as never,
        targetProduct: 'Article',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        substitutionAuthorized: opts.substitutionAuthorized ?? false,
        dropoffReceiptUrl: opts.status === 'DEPOSITED' ? 'https://proofs.waylo.app/d.pdf' : null,
        dropoffAt: opts.status === 'DEPOSITED' ? new Date() : null,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_${mission.id}`,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission.id
  }

  it('/validate standard → capture budget + commission, clé capture_<id>', async () => {
    captures.length = 0
    const id = await seed({ status: 'AWAITING_VALIDATION' })
    const res = await app.inject({ method: 'POST', url: `/api/missions/${id}/validate`, headers: bearer() })

    expect(res.statusCode).toBe(200)
    expect(captures).toEqual([{ id: `pi_${id}`, key: `capture_${id}`, amount: STANDARD_CAPTURE }])
  })

  it('/validate substitution → capture floor(budget×1,2) + commission', async () => {
    captures.length = 0
    const id = await seed({ status: 'AWAITING_VALIDATION', substitutionAuthorized: true })
    const res = await app.inject({ method: 'POST', url: `/api/missions/${id}/validate`, headers: bearer() })

    expect(res.statusCode).toBe(200)
    expect(captures).toEqual([{ id: `pi_${id}`, key: `capture_${id}`, amount: SUBSTITUTION_CAPTURE }])
  })

  it('/confirm-collection substitution → capture 120%, clé capture_collection_<id>', async () => {
    captures.length = 0
    const id = await seed({ status: 'DEPOSITED', substitutionAuthorized: true })
    const res = await app.inject({
      method: 'POST',
      url: `/api/missions/${id}/confirm-collection`,
      headers: bearer(),
    })

    expect(res.statusCode).toBe(200)
    expect(captures).toEqual([
      { id: `pi_${id}`, key: `capture_collection_${id}`, amount: SUBSTITUTION_CAPTURE },
    ])
  })
})
