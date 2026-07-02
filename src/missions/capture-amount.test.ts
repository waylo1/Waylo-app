import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import { captureEscrowFunds } from '../services/escrow.service'
import { resetDb } from '../../tests/helpers/db-reset'
import { hashQrCode } from './qr-proof'

const QR_RAW = 'WAYLO-CAPTURE-SEAL-TEST-4F8B1'
const QR_HASH = hashQrCode(QR_RAW)

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
        innerQrCodeHash: opts.status === 'DEPOSITED' ? QR_HASH : null,
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

  it('/validate standard → capture budget + commission, clé waylo:<id>:cap:validate:v1', async () => {
    captures.length = 0
    const id = await seed({ status: 'AWAITING_VALIDATION' })
    const res = await app.inject({ method: 'POST', url: `/api/missions/${id}/validate`, headers: bearer() })

    expect(res.statusCode).toBe(200)
    expect(captures).toEqual([
      { id: `pi_${id}`, key: `waylo:${id}:cap:validate:v1`, amount: STANDARD_CAPTURE },
    ])
  })

  it('/validate substitution → capture floor(budget×1,2) + commission', async () => {
    captures.length = 0
    const id = await seed({ status: 'AWAITING_VALIDATION', substitutionAuthorized: true })
    const res = await app.inject({ method: 'POST', url: `/api/missions/${id}/validate`, headers: bearer() })

    expect(res.statusCode).toBe(200)
    expect(captures).toEqual([
      { id: `pi_${id}`, key: `waylo:${id}:cap:validate:v1`, amount: SUBSTITUTION_CAPTURE },
    ])
  })

  it('/confirm-collection substitution → capture 120%, clé waylo:<id>:cap:collection:v1', async () => {
    captures.length = 0
    const id = await seed({ status: 'DEPOSITED', substitutionAuthorized: true })
    const res = await app.inject({
      method: 'POST',
      url: `/api/missions/${id}/confirm-collection`,
      headers: { ...bearer(), 'content-type': 'application/json' },
      payload: JSON.stringify({ innerQrCode: QR_RAW }),
    })

    expect(res.statusCode).toBe(200)
    expect(captures).toEqual([
      { id: `pi_${id}`, key: `waylo:${id}:cap:collection:v1`, amount: SUBSTITUTION_CAPTURE },
    ])
  })
})

describe('Capture — idempotence Stripe (AUDIT-00-IDEM)', () => {
  let prisma: PrismaClient
  let buyer: User

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-idempotence@test.waylo' } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function seedHeldMission(): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'AWAITING_VALIDATION' as never,
        targetProduct: 'Article',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
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

  it('2 appels concurrents même clé → le 2e reflète le rejet Stripe (dédup active), aucun impact DB', async () => {
    const id = await seedHeldMission()
    const usedKeys = new Set<string>()
    // Simule le comportement Stripe pour deux requêtes concurrentes partageant la
    // même idempotencyKey : la 2e requête, tant que la 1re n'a pas terminé côté
    // Stripe, est rejetée (Stripe : "a request is currently being processed").
    const raceStripe: PaymentIntentClient = {
      paymentIntents: {
        create: async params => ({ id: `pi_${params.metadata['missionId']}`, client_secret: 'secret' }),
        capture: async (piId, _params, options) => {
          if (usedKeys.has(options.idempotencyKey)) {
            throw new Error('IDEMPOTENCY_KEY_IN_USE')
          }
          usedKeys.add(options.idempotencyKey)
          return { id: piId }
        },
      },
    }

    const [first, second] = await Promise.allSettled([
      captureEscrowFunds(id, raceStripe, 'validate'),
      captureEscrowFunds(id, raceStripe, 'validate'),
    ])

    const outcomes = [first, second]
    const fulfilled = outcomes.filter(r => r.status === 'fulfilled')
    const rejected = outcomes.filter(r => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('IDEMPOTENCY_KEY_IN_USE')

    // Aucun impact DB : captureEscrowFunds n'écrit rien (source de vérité = webhook),
    // l'escrow reste HELD que la capture ait réussi ou échoué côté Stripe.
    const escrow = await prisma.escrowTransaction.findUnique({ where: { missionId: id } })
    expect(escrow?.status).toBe('HELD')
  })
})
