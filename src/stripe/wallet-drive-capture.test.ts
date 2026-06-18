import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Close-out « Drive » — capture 120% + reliquat Wallet (Sprint 18, POST /api/stripe/webhook).
 *
 * Sur une mission à substitution pré-autorisée, le séquestre est capturé À 120% du
 * budget (+ commission). Le webhook `payment_intent.succeeded` décompose la capture :
 *   PAYOUT      = dépense réelle voyageur (`purchaseAmountCents`)  → TransferOutbox
 *   COMMISSION  = frais plateforme
 *   BUYER_WALLET_CREDIT = reliquat (spendable − dépense)           → Wallet acheteur
 * CAPTURE = PAYOUT + COMMISSION + BUYER_WALLET_CREDIT (invariants B/C préservés).
 * ZÉRO décaissement Stripe pour le reliquat : crédit interne au Wallet.
 *
 * (1) substitution + capture 120% : ledger décomposé, TransferOutbox = dépense réelle,
 *     Wallet acheteur crédité du reliquat, mission RELEASED, réconciliation saine ;
 * (2) hors substitution : aucun Wallet, payout = capturé − commission (non-régression).
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test (conteneur flipsync-pg:5433).
 */

const WEBHOOK_SECRET = 'whsec_test_async'
const BUDGET_CENTS = 50_000
const COMMISSION_CENTS = 5_000
const CAP_CENTS = Math.floor((BUDGET_CENTS * 12) / 10) // 60_000 (120%)
const FULL_CAPTURE_CENTS = CAP_CENTS + COMMISSION_CENTS // 65_000 (provision intégrale)
const PURCHASE_CENTS = 56_000 // dépense réelle en magasin (entre budget et 120%)
const RELIQUAT_CENTS = CAP_CENTS - PURCHASE_CENTS // 4_000 (= spendable − dépense)

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('Close-out Drive — capture 120% + reliquat Wallet (Sprint 18)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  const stripe = new Stripe('sk_test_dummy')

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()
    await wipe()
    buyer = await prisma.user.create({
      data: { email: 'buyer-wallet-drive@test.waylo', kycStatus: 'VERIFIED' },
    })
    // Voyageur VERIFIED + compte Connect : la précondition de versement passe → on
    // atteint la décomposition PAYOUT / WALLET.
    traveler = await prisma.user.create({
      data: {
        email: 'traveler-wallet-drive@test.waylo',
        kycStatus: 'VERIFIED',
        stripeAccountId: 'acct_test_wallet_drive',
      },
    })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  async function wipe(): Promise<void> {
    await prisma.walletTransaction.deleteMany()
    await prisma.wallet.deleteMany()
    await prisma.penaltyDebitOutbox.deleteMany()
    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.issuingAuthorizationLog.deleteMany()
    await prisma.review.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.adminAuditLog.deleteMany()
  }

  // Purge les missions/wallets entre cas (users conservés).
  beforeEach(async () => {
    await prisma.walletTransaction.deleteMany()
    await prisma.wallet.deleteMany()
    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
  })

  async function seed(opts: {
    substitutionAuthorized: boolean
    piId: string
  }): Promise<{ missionId: string; escrowId: string }> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'VALIDATED', // /validate déjà passé : le webhook finalise en RELEASED
        targetProduct: 'Article substituable',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        substitutionAuthorized: opts.substitutionAuthorized,
        purchaseAmountCents: PURCHASE_CENTS,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: opts.piId,
        status: 'HELD',
        spendingLimitCents: opts.substitutionAuthorized ? CAP_CENTS : BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return { missionId: mission.id, escrowId: escrow.id }
  }

  function fireCapture(eventId: string, piId: string, amountReceived: number) {
    const payload = JSON.stringify({
      id: eventId,
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: piId, object: 'payment_intent', amount_received: amountReceived } },
    })
    return app.inject({
      method: 'POST',
      url: '/api/stripe/webhook',
      payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
    })
  }

  const sumLedger = async (escrowId: string, type: string) =>
    (
      await prisma.ledgerEntry.aggregate({
        where: { escrowId, type: type as never },
        _sum: { amountCents: true },
      })
    )._sum.amountCents ?? 0

  it('(1) substitution : capture 120% décomposée, TransferOutbox = dépense réelle, Wallet acheteur crédité du reliquat', async () => {
    const piId = 'pi_wallet_drive_sub'
    const { missionId, escrowId } = await seed({ substitutionAuthorized: true, piId })

    const res = await fireCapture('evt_wallet_drive_sub', piId, FULL_CAPTURE_CENTS)
    expect(res.statusCode).toBe(200)

    // Escrow soldé à la capture intégrale.
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id: escrowId } })
    expect(escrow.status).toBe('RELEASED')
    expect(escrow.capturedAmountCents).toBe(FULL_CAPTURE_CENTS) // 65_000

    // Décomposition exacte du ledger.
    expect(await sumLedger(escrowId, 'CAPTURE')).toBe(FULL_CAPTURE_CENTS) // 65_000
    expect(await sumLedger(escrowId, 'PAYOUT')).toBe(PURCHASE_CENTS) // 56_000 (dépense réelle)
    expect(await sumLedger(escrowId, 'COMMISSION')).toBe(COMMISSION_CENTS) // 5_000
    expect(await sumLedger(escrowId, 'BUYER_WALLET_CREDIT')).toBe(RELIQUAT_CENTS) // 4_000

    // Versement voyageur = dépense réelle (jamais le reliquat).
    const transfers = await prisma.transferOutbox.findMany({ where: { escrowId } })
    expect(transfers).toHaveLength(1)
    expect(transfers[0]?.amountCents).toBe(PURCHASE_CENTS)
    expect(transfers[0]?.destinationAccountId).toBe('acct_test_wallet_drive')

    // Wallet interne acheteur crédité du reliquat (zéro décaissement Stripe).
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })
    expect(wallet.balanceCents).toBe(RELIQUAT_CENTS) // 4_000
    const walletTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { missionId } })
    expect(walletTx.amountCents).toBe(RELIQUAT_CENTS)
    expect(walletTx.walletId).toBe(wallet.id)

    // Mission finalisée.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe('RELEASED')

    // Invariant ledger sain : CAPTURE == PAYOUT + COMMISSION + BUYER_WALLET_CREDIT.
    const { runReconciliation } = await import('../workers/reconciliation')
    const alerts = await runReconciliation({ prisma, onAlert: () => {} })
    expect(alerts.filter(a => a.code === 'LEDGER_INVARIANT_BROKEN')).toHaveLength(0)
  })

  it('(2) hors substitution : aucun Wallet, payout = capturé − commission (non-régression)', async () => {
    const piId = 'pi_wallet_drive_nosub'
    const { escrowId } = await seed({ substitutionAuthorized: false, piId })

    // Hors substitution, capture nominale = budget + commission.
    const res = await fireCapture('evt_wallet_drive_nosub', piId, BUDGET_CENTS + COMMISSION_CENTS)
    expect(res.statusCode).toBe(200)

    expect(await sumLedger(escrowId, 'PAYOUT')).toBe(BUDGET_CENTS) // capturé − commission
    expect(await sumLedger(escrowId, 'COMMISSION')).toBe(COMMISSION_CENTS)
    expect(await sumLedger(escrowId, 'BUYER_WALLET_CREDIT')).toBe(0)

    // Aucun crédit Wallet, aucun mouvement interne.
    expect(await prisma.wallet.count({ where: { userId: buyer.id } })).toBe(0)
    expect(await prisma.walletTransaction.count()).toBe(0)
  })
})
