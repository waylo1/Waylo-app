import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '../generated/prisma'
import type { OpsAlert } from '../alerts'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * Durcissement webhook payment_intent.succeeded (CORE-STAB) :
 * (A) idempotence interne : escrow déjà RELEASED → un event DISTINCT (autre
 *     event.id, même PI) est ignoré — aucun double effet, aucun abort parasite ;
 * (B) notifications ESCROW_RELEASED : acheteur + voyageur notifiés post-commit
 *     (idempotent, un alias ProcessedMissionEvent par destinataire) ;
 * (C) missionId introuvable : PI marqué Waylo (metadata.missionId) sans escrow
 *     → alerte critique WEBHOOK_MISSION_NOT_FOUND, event acquitté (200) ;
 * (D) PI étranger (aucune metadata) → acquitté SANS alerte (comportement conservé) ;
 * (E) libération partielle (compte Connect absent) → AUCUNE notification
 *     escrow-released (émise uniquement sur libération complète).
 *
 * Prérequis : DATABASE_URL → base waylo_test.
 */

const WEBHOOK_SECRET = 'whsec_test_async'
const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('POST /api/stripe/webhook — durcissement payment_intent.succeeded (CORE-STAB)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  const alerts: OpsAlert[] = []

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ onAlert: alert => alerts.push(alert) })
    await resetDb(prisma)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const stripe = new Stripe('sk_test_dummy')
  const injectIntentSucceeded = (
    eventId: string,
    object: Record<string, unknown>,
  ) => {
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { object: 'payment_intent', ...object } },
    })
    return app.inject({
      method: 'POST',
      url: '/api/stripe/webhook',
      payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({
          payload,
          secret: WEBHOOK_SECRET,
        }),
      },
    })
  }

  /** Poll borné (fire-and-forget post-commit : la notification suit la réponse HTTP). */
  async function waitForCount(
    fn: () => Promise<number>,
    expected: number,
    timeoutMs = 2_000,
  ): Promise<number> {
    const deadline = Date.now() + timeoutMs
    let count = await fn()
    while (count !== expected && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      count = await fn()
    }
    return count
  }

  /** Mission + escrow HELD, voyageur payable (Connect vérifié) — prêt pour la libération. */
  async function seedReleasable(tag: string, travelerData?: Record<string, unknown>) {
    // stripeAccountId est @unique sur User → un compte distinct par seed.
    travelerData ??= { kycStatus: 'VERIFIED', stripeAccountId: `acct_test_${tag}` }
    const buyer = await prisma.user.create({
      data: { email: `buyer-${tag}@test.waylo`, kycStatus: 'VERIFIED' },
    })
    const traveler = await prisma.user.create({
      data: { email: `traveler-${tag}@test.waylo`, ...travelerData },
    })
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'AWAITING_VALIDATION',
        targetProduct: 'Article hardening',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_hardening_${tag}`,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return { mission, buyer, traveler, piId: `pi_hardening_${tag}` }
  }

  it('(A) escrow déjà RELEASED → event DISTINCT ignoré (acquit, un seul PAYOUT, aucun abort)', async () => {
    const { mission, piId } = await seedReleasable('released')

    const first = await injectIntentSucceeded('evt_hardening_release_a', {
      id: piId,
      amount_received: BUDGET_CENTS,
    })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ duplicate: false, handled: true })

    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({
      where: { missionId: mission.id },
    })
    expect(escrow.status).toBe('RELEASED')

    // Doublon tardif sous un AUTRE event.id : passe la barrière ProcessedStripeEvent,
    // arrêté par la garde d'idempotence interne (statut RELEASED relu sous verrou).
    const alertsBefore = alerts.length
    const second = await injectIntentSucceeded('evt_hardening_release_b', {
      id: piId,
      amount_received: BUDGET_CENTS,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ duplicate: false, handled: false })

    const payouts = await prisma.ledgerEntry.findMany({
      where: { escrowId: escrow.id, type: 'PAYOUT' },
    })
    expect(payouts).toHaveLength(1)
    // Aucun abort parasite (WEBHOOK_ABORT_NON_RECOVERABLE) sur le doublon.
    expect(alerts.slice(alertsBefore)).toHaveLength(0)
  })

  it('(B) libération complète → notifications escrow-released acheteur + voyageur (idempotentes)', async () => {
    const { mission, piId } = await seedReleasable('notify')

    const res = await injectIntentSucceeded('evt_hardening_notify', {
      id: piId,
      amount_received: BUDGET_CENTS,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ handled: true })

    // Fire-and-forget post-commit : un alias ProcessedMissionEvent PAR destinataire.
    const count = await waitForCount(
      () =>
        prisma.processedMissionEvent.count({
          where: {
            missionId: mission.id,
            alias: { in: ['notif:escrow-released:buyer', 'notif:escrow-released:traveler'] },
          },
        }),
      2,
    )
    expect(count).toBe(2)
  })

  it('(C) metadata.missionId sans escrow en DB → alerte critique WEBHOOK_MISSION_NOT_FOUND, event acquitté', async () => {
    const res = await injectIntentSucceeded('evt_hardening_orphan', {
      id: 'pi_ghost_no_escrow',
      amount_received: 5_000,
      metadata: { missionId: 'mission_ghost_123' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ duplicate: false, handled: false })

    const orphanAlerts = alerts.filter(a => a.code === 'WEBHOOK_MISSION_NOT_FOUND')
    expect(orphanAlerts).toHaveLength(1)
    expect(orphanAlerts[0]).toMatchObject({
      severity: 'critical',
      details: { missionId: 'mission_ghost_123', intentId: 'pi_ghost_no_escrow' },
    })
  })

  it('(D) PI étranger (aucune metadata missionId) → acquitté SANS alerte', async () => {
    const alertsBefore = alerts.length
    const res = await injectIntentSucceeded('evt_hardening_foreign', {
      id: 'pi_foreign_service',
      amount_received: 7_000,
      metadata: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ duplicate: false, handled: false })
    expect(alerts.slice(alertsBefore)).toHaveLength(0)
  })

  it('(E) compte Connect absent (pas de libération) → AUCUNE notification escrow-released', async () => {
    const { mission, piId } = await seedReleasable('noaccount', {
      kycStatus: 'VERIFIED',
      stripeAccountId: null,
    })

    const res = await injectIntentSucceeded('evt_hardening_noaccount', {
      id: piId,
      amount_received: BUDGET_CENTS,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ handled: true })
    // L'alerte ops TRAVELER_ACCOUNT_MISSING est le canal de ce chemin, pas la notif.
    expect(alerts.some(a => a.code === 'TRAVELER_ACCOUNT_MISSING')).toBe(true)

    // Laisse le temps à une éventuelle notification erronée d'apparaître.
    const count = await waitForCount(
      () =>
        prisma.processedMissionEvent.count({
          where: { missionId: mission.id, alias: { startsWith: 'notif:escrow-released' } },
        }),
      1,
      300,
    )
    expect(count).toBe(0)
  })
})
