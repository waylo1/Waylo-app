import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from './generated/prisma'
import type { PaymentIntentClient } from './missions/mission-common'
import { resetDb } from '../tests/helpers/db-reset'

/**
 * Stress test F2 — POST /api/escrow/:missionId/capture
 *
 * Preuve d'atomicité du CAS (Compare-And-Swap) sur status=AWAITING_VALIDATION :
 *   • 50 appels concurrents sur la même mission.
 *   • PostgreSQL garantit qu'un seul UPDATE WHERE status=AWAITING_VALIDATION
 *     retourne count=1 — les 49 autres voient count=0 → 409.
 *   • captureEscrowFunds (Stripe) N'est appelé qu'une seule fois.
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
const CONCURRENCY = 50

describe('Stress escrow capture — preuve atomicité CAS F2', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let buyerToken: string
  let stripeCaptureCalls = 0

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (_params, _opts) => ({ id: 'pi_stress', client_secret: 'secret_stress' }),
      capture: async (id, _params, _opts) => {
        stripeCaptureCalls++
        return { id }
      },
    },
  }

  beforeAll(async () => {
    prisma = (await import('./db')).prisma
    app = await (await import('./app')).buildApp({ stripe: fakeStripe })
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-stress-escrow@test.waylo' } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it(`(F2) ${CONCURRENCY} captures concurrentes → 1 succès, ${CONCURRENCY - 1} rejets CAS, 1 seul appel Stripe`, async () => {
    // Mission en AWAITING_VALIDATION + escrow HELD — état exact pré-capture.
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'AWAITING_VALIDATION',
        targetProduct: 'Produit stress test CAS',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: 'pi_stress',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })

    stripeCaptureCalls = 0
    const headers = { authorization: `Bearer ${buyerToken}` }
    const url = `/api/escrow/${mission.id}/capture`

    // Rafale de 50 requêtes concurrentes sur la même missionId.
    const responses = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        app.inject({ method: 'POST', url, headers }),
      ),
    )

    const statusCodes = responses.map(r => r.statusCode)
    const successes = statusCodes.filter(s => s === 200)
    const collisions = statusCodes.filter(s => s === 409)
    const unexpected = statusCodes.filter(s => s !== 200 && s !== 409)

    // ── Assertions F2 ───────────────────────────────────────────────────────
    // Un seul claim atomique doit passer : exactement 1 × 200.
    expect(successes, `Attendu 1 succès, obtenu : ${successes.length}`).toHaveLength(1)
    // Les 49 autres doivent être bloqués par le CAS → 409 CUSTOMS_LOCK_ACTIVE.
    expect(collisions, `Attendu ${CONCURRENCY - 1} collisions CAS`).toHaveLength(CONCURRENCY - 1)
    // Aucun statut inattendu (500, 503, 400…).
    expect(unexpected, `Codes inattendus : ${unexpected.join(', ')}`).toHaveLength(0)

    // captureEscrowFunds NE doit être appelé QU'UNE SEULE FOIS (pas de double débit Stripe).
    expect(stripeCaptureCalls, 'Stripe ne doit être appelé qu\'une seule fois').toBe(1)

    // Mission en VALIDATED après le claim gagnant.
    const after = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(after.status).toBe('VALIDATED')
  })

  it('(Circuit Breaker) Stripe systématiquement en panne → circuit s\'ouvre, rollback DB', async () => {
    let stripeFailCalls = 0
    const failingStripe: PaymentIntentClient = {
      paymentIntents: {
        create: async () => ({ id: 'pi_cb_test', client_secret: 'secret_cb' }),
        capture: async () => {
          stripeFailCalls++
          throw new Error('SIMULATED_STRIPE_OUTAGE')
        },
      },
    }
    const cbApp = await (await import('./app')).buildApp({ stripe: failingStripe })

    // Nouvelle mission en AWAITING_VALIDATION pour ce test.
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'AWAITING_VALIDATION',
        targetProduct: 'Produit CB test',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Osaka',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: 'pi_cb_test',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })

    const headers = { authorization: `Bearer ${cbApp.jwt.sign({ sub: buyer.id })}` }
    const url = `/api/escrow/${mission.id}/capture`

    // Premier appel : Stripe échoue → 500, mission rollback → AWAITING_VALIDATION.
    const res = await cbApp.inject({ method: 'POST', url, headers })
    expect(res.statusCode).toBe(500)

    // DB rollback : mission revenue en AWAITING_VALIDATION.
    const rollbacked = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(rollbacked.status).toBe('AWAITING_VALIDATION')
    expect(stripeFailCalls).toBe(1)

    await cbApp.close()
  })
})
