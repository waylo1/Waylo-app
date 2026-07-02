import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import type { PaymentIntentClient } from './mission-common'
import type { OpsAlert } from '../alerts'
import { registerAlias, registerBuiltinAliases } from '@waylo/shared/automation'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * GUARD CLAUSE de capture (CORE-STAB, Tâche 1) : si la capture Stripe échoue
 * après épuisement des retries de l'alias 'stripe-capture', le statut métier
 * ne doit JAMAIS avancer, et l'admin doit être alerté (CAPTURE_FAILED, critical
 * → webhook Slack en prod).
 *
 * (A) customs-approve : PENDING_CUSTOMS_REVIEW reste INCHANGÉ, escrow HELD,
 *     aucun AdminAuditLog, 502 ESCROW_CAPTURE_FAILED, alerte CAPTURE_FAILED ;
 * (B) /validate : AWAITING_VALIDATION reste INCHANGÉ, mêmes garanties.
 *
 * L'alias 'stripe-capture' est ré-enregistré avec un backoff quasi nul pour que
 * l'épuisement (2 tentatives) soit instantané — restauré en afterAll.
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

const BUDGET_CENTS = 50_000
const COMMISSION_CENTS = 5_000

describe('Garde de capture — échec Stripe après retries (CAPTURE_FAILED)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let admin: User
  let buyerToken: string
  let adminToken: string
  const alerts: OpsAlert[] = []

  // Stripe indisponible : CHAQUE tentative de capture échoue → épuisement garanti.
  const downStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async params => ({ id: `pi_cfg_${params.metadata['missionId']}`, client_secret: 'secret' }),
      capture: async () => {
        throw new Error('STRIPE_NETWORK_DOWN')
      },
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({
      stripe: downStripe,
      onAlert: alert => alerts.push(alert),
    })
    // Épuisement instantané : 2 tentatives, backoff 1 ms (config restaurée en afterAll).
    registerAlias({
      name: 'stripe-capture',
      maxRetries: 1,
      backoffMs: 1,
      timeoutMs: 500,
      exponentialFactor: 2,
    })
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-cfg@test.waylo' } })
    admin = await prisma.user.create({ data: { email: 'admin-cfg@test.waylo', isAdmin: true } })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    adminToken = app.jwt.sign({ sub: admin.id })
  })

  afterAll(async () => {
    registerBuiltinAliases() // restaure la config nominale de 'stripe-capture'
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  async function seedMission(status: string): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: status as never,
        targetProduct: 'Article garde capture',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        ...(status === 'PENDING_CUSTOMS_REVIEW'
          ? {
              destinationCountry: 'JP',
              purchaseAmountCents: 45_000,
              customsReceiptUrl: 'https://receipts.waylo.app/qr.pdf',
              customsReceiptSha256: 'sha256hashtest',
            }
          : {}),
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_customs_${mission.id}`,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission.id
  }

  it('(A) customs-approve : retries épuisés → 502, alerte CAPTURE_FAILED, statut douanier JAMAIS avancé', async () => {
    const id = await seedMission('PENDING_CUSTOMS_REVIEW')
    const res = await app.inject({
      method: 'POST',
      url: `/api/missions/${id}/customs-approve`,
      headers: bearer(adminToken),
    })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ error: 'ESCROW_CAPTURE_FAILED' })

    // Alerte admin (critical → webhook Slack en prod) avec le contexte d'échec.
    const captureAlerts = alerts.filter(a => a.code === 'CAPTURE_FAILED')
    expect(captureAlerts).toHaveLength(1)
    expect(captureAlerts[0]).toMatchObject({
      severity: 'critical',
      details: { missionId: id, context: 'customs', attempts: 2 },
    })

    // GUARD CLAUSE : le statut logistique n'a JAMAIS avancé, l'escrow reste HELD,
    // aucune décision admin n'est journalisée.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe('PENDING_CUSTOMS_REVIEW')
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId: id } })
    expect(escrow.status).toBe('HELD')
    expect(await prisma.adminAuditLog.count({ where: { missionId: id } })).toBe(0)
  })

  it('(B) /validate : retries épuisés → 502, alerte CAPTURE_FAILED, mission reste AWAITING_VALIDATION', async () => {
    const id = await seedMission('AWAITING_VALIDATION')
    const alertsBefore = alerts.length
    const res = await app.inject({
      method: 'POST',
      url: `/api/missions/${id}/validate`,
      headers: bearer(buyerToken),
    })

    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ error: 'ESCROW_CAPTURE_FAILED' })

    const captureAlerts = alerts.slice(alertsBefore).filter(a => a.code === 'CAPTURE_FAILED')
    expect(captureAlerts).toHaveLength(1)
    expect(captureAlerts[0]?.details).toMatchObject({ missionId: id, context: 'validate' })

    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe('AWAITING_VALIDATION')
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId: id } })
    expect(escrow.status).toBe('HELD')
  })
})
