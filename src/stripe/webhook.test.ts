import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '../generated/prisma'
import type { OpsAlert } from '../alerts'

/**
 * D3 — Garde de capture sur verrou douanier. Une mission ESCROW_LOCKED_CUSTOMS
 * (taxes non prouvées) ne doit JAMAIS voir ses fonds libérés par une capture
 * Stripe : handleCapture détecte l'état douanier APRÈS la libération provisoire
 * et abort → rollback INTÉGRAL (escrow HELD, capturedAmountCents 0, ledger vide,
 * aucun TransferOutbox, event non marqué processé) + alerte critical
 * CUSTOMS_LOCK_CAPTURED émise AVANT le throw (visibilité survit au rollback).
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 */

const WEBHOOK_SECRET = 'whsec_test_async'
const PI_ID = 'pi_waylo_customs_lock_test'
const EVENT_ID = 'evt_waylo_customs_lock_test'
const BUDGET_CENTS = 50_000
const COMMISSION_CENTS = 5_000

// Garde-fou : ne jamais exécuter ce test contre la base FlipSync/Waylo de dev.
if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('POST /api/stripe/webhook — garde capture verrou douanier (D3)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let missionId: string
  let escrowId: string
  const alerts: OpsAlert[] = []

  beforeAll(async () => {
    // Imports dynamiques : env vars posées avant l'instanciation du PrismaClient.
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({
      onAlert: alert => {
        alerts.push(alert)
      },
    })

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

    const buyer = await prisma.user.create({
      data: { email: 'buyer-customs-lock@test.waylo', kycStatus: 'VERIFIED' },
    })
    // Voyageur VERIFIED + compte Connect : la précondition de versement (ÉTAPE 2)
    // doit PASSER, sinon le flux sort en AWAITING_TRAVELER_ACCOUNT avant la garde.
    const traveler = await prisma.user.create({
      data: {
        email: 'traveler-customs-lock@test.waylo',
        kycStatus: 'VERIFIED',
        stripeAccountId: 'acct_test_customs_lock',
      },
    })
    // Mission en verrou douanier : valeur déclarée > seuil, taxes non prouvées.
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'ESCROW_LOCKED_CUSTOMS',
        targetProduct: 'Montre de luxe importée',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'New York',
        destinationCountry: 'US',
        purchaseAmountCents: BUDGET_CENTS,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    missionId = mission.id
    // Escrow T0 : HELD, jamais capturé — état AVANT la capture différée.
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: PI_ID,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: 'idem_waylo_customs_lock',
      },
    })
    escrowId = escrow.id
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  it('abort + rollback intégral quand payment_intent.succeeded vise une mission ESCROW_LOCKED_CUSTOMS', async () => {
    const payload = JSON.stringify({
      id: EVENT_ID,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: PI_ID,
          object: 'payment_intent',
          amount_received: BUDGET_CENTS + COMMISSION_CENTS,
        },
      },
    })
    const stripe = new Stripe('sk_test_dummy')
    const res = await app.inject({
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

    // Abort délibéré → rollback intégral → 500 (Stripe rejouera). Le code de
    // réponse reste WEBHOOK_PROCESSING_FAILED (générique) ; le signal métier
    // précis est porté par l'alerte.
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'WEBHOOK_PROCESSING_FAILED' })

    // Alerte critical émise AVANT le throw — survit au rollback.
    const customsAlert = alerts.find(a => a.code === 'CUSTOMS_LOCK_CAPTURED')
    expect(customsAlert).toBeDefined()
    expect(customsAlert?.severity).toBe('critical')
    expect(customsAlert?.details).toMatchObject({
      missionId,
      escrowId,
      missionStatus: 'ESCROW_LOCKED_CUSTOMS',
    })
    // L'abort n'est PAS reclassé en erreur inattendue (pas de double alerte).
    expect(alerts.some(a => a.code === 'WEBHOOK_PROCESSING_FAILED')).toBe(false)

    // Rollback prouvé : la mission reste verrouillée, l'escrow n'a rien capturé.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe('ESCROW_LOCKED_CUSTOMS')
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('HELD')
    expect(escrow.capturedAmountCents).toBe(0)

    // Aucune écriture comptable, aucune intention de versement n'a survécu.
    expect(await prisma.ledgerEntry.count({ where: { escrowId } })).toBe(0)
    expect(await prisma.transferOutbox.count({ where: { escrowId } })).toBe(0)

    // Event NON marqué processé : Stripe rejouera tant que le verrou persiste.
    expect(
      await prisma.processedStripeEvent.count({ where: { stripeEventId: EVENT_ID } }),
    ).toBe(0)
  })
})
