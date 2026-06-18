import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Arbitrage admin de FRAUDE / VOL voyageur — POST /api/admin/missions/:id/arbitrate-fraud
 * (Sprint 14). Réservé aux admins (`isRequestAdmin`). Sur une mission `DISPUTED`, dans
 * une seule `$transaction` (aucun appel Stripe) : transition `DISPUTED → DISPUTED_FRAUD`,
 * ponction 200% (`PenaltyDebitOutbox`), journalisation 200%/120% (`LedgerEntry`), audit.
 *
 * Base de calcul : (budget [Valeur Objet] + commission [Frais Service]) ;
 * ponction = base × 2 (200%), compensation acheteur = base × 1,2 (120%),
 * marge plateforme implicite = base × 0,8 (80% = 200% − 120%).
 *
 * Les types `FRAUD_PENALTY_COLLECTED` / `BUYER_REFUND_COMPENSATION` sont ancrés à
 * l'escrow pour la FK mais EXCLUS des invariants ledger A/B/C (la réconciliation ne
 * somme que CAPTURE/PAYOUT/COMMISSION/REFUND) — aucune corruption de l'escrow acheteur.
 *
 * (1) admin → 200 `DISPUTED_FRAUD` ; outbox 200% pour le voyageur ; ledger 200%/120% ; audit ;
 * (2) non-admin (buyer/traveler) → 403 ; non authentifié → 401 ; aucune écriture, mission intacte ;
 * (3) mission non-`DISPUTED` → 400 ; double arbitrage → 400 sans doublon (idempotence anti-TOCTOU).
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

const BUDGET_CENTS = 10_000 // Valeur Objet
const COMMISSION_CENTS = 1_500 // Frais Service Plateforme
const BASE_CENTS = BUDGET_CENTS + COMMISSION_CENTS // 11_500
const PENALTY_CENTS = BASE_CENTS * 2 // 23_000 (200%)
const COMPENSATION_CENTS = Math.round((BASE_CENTS * 12) / 10) // 13_800 (120%)
const PLATFORM_MARGIN_CENTS = PENALTY_CENTS - COMPENSATION_CENTS // 9_200 (80%)

describe('Arbitrage admin fraude voyageur — POST /api/admin/missions/:id/arbitrate-fraud (Sprint 14)', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let admin: User
  let buyer: User
  let traveler: User
  let adminToken: string
  let buyerToken: string
  let travelerToken: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()

    await prisma.penaltyDebitOutbox.deleteMany()
    await prisma.buyerCompensationOutbox.deleteMany()
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
    await prisma.user.deleteMany()

    admin = await prisma.user.create({ data: { email: 'admin-fraud@test.waylo', isAdmin: true } })
    buyer = await prisma.user.create({ data: { email: 'buyer-fraud@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-fraud@test.waylo' } })

    adminToken = app.jwt.sign({ sub: admin.id })
    buyerToken = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const arbitrate = (missionId: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/admin/missions/${missionId}/arbitrate-fraud`,
      headers,
    })

  /** Mission au statut donné (défaut DISPUTED) + escrow HELD. */
  async function seedMission(status: 'DISPUTED' | 'FUNDED' = 'DISPUTED') {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status,
        targetProduct: 'Article détourné',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_fraud_${mission.id}`,
        status: 'HELD',
        spendingLimitCents: BUDGET_CENTS,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission
  }

  it('(1) admin → 200 DISPUTED_FRAUD ; ponction 200% + compensation 120% + outbox + audit', async () => {
    const mission = await seedMission()
    const res = await arbitrate(mission.id, bearer(adminToken))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: mission.id, status: 'DISPUTED_FRAUD' })

    // PenaltyDebitOutbox : voyageur ciblé, montant 200%, statut PENDING (exécution différée).
    const outbox = await prisma.penaltyDebitOutbox.findUniqueOrThrow({
      where: { missionId: mission.id },
    })
    expect(outbox.userId).toBe(traveler.id)
    expect(outbox.amountCents).toBe(PENALTY_CENTS) // 23_000
    expect(outbox.status).toBe('PENDING')

    // BuyerCompensationOutbox : acheteur bénéficiaire, montant 120%, PENDING, clé idempotente.
    const compensationOutbox = await prisma.buyerCompensationOutbox.findFirstOrThrow({
      where: { missionId: mission.id },
    })
    expect(compensationOutbox.buyerId).toBe(buyer.id)
    expect(compensationOutbox.amountCents).toBe(COMPENSATION_CENTS) // 13_800 (120%)
    expect(compensationOutbox.status).toBe('PENDING')
    expect(compensationOutbox.idempotencyKey).toBe(`buyer_compensation_${mission.id}`)

    // Ledger : 200% collecté + 120% compensation, ancrés à l'escrow de la mission.
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({
      where: { missionId: mission.id },
    })
    const penalty = await prisma.ledgerEntry.findFirstOrThrow({
      where: { escrowId: escrow.id, type: 'FRAUD_PENALTY_COLLECTED' },
    })
    const compensation = await prisma.ledgerEntry.findFirstOrThrow({
      where: { escrowId: escrow.id, type: 'BUYER_REFUND_COMPENSATION' },
    })
    expect(penalty.amountCents).toBe(PENALTY_CENTS) // 23_000 (200%)
    expect(compensation.amountCents).toBe(COMPENSATION_CENTS) // 13_800 (120%)
    // Marge plateforme implicite = ponction − compensation = 80%.
    expect(penalty.amountCents - compensation.amountCents).toBe(PLATFORM_MARGIN_CENTS) // 9_200

    // Décision tracée (invariant D-c).
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { missionId: mission.id, action: 'ADMIN_ARBITRATE_FRAUD' },
    })
    expect(audit.adminId).toBe(admin.id)
  })

  it('(2) non-admin → 403 ; non authentifié → 401 ; aucune écriture, mission intacte', async () => {
    const mission = await seedMission()

    const byBuyer = await arbitrate(mission.id, bearer(buyerToken))
    expect(byBuyer.statusCode).toBe(403)
    expect(byBuyer.json()).toEqual({ error: 'FORBIDDEN' })

    const byTraveler = await arbitrate(mission.id, bearer(travelerToken))
    expect(byTraveler.statusCode).toBe(403)

    const unauth = await arbitrate(mission.id)
    expect(unauth.statusCode).toBe(401)
    expect(unauth.json()).toEqual({ error: 'UNAUTHORIZED' })

    // Aucun effet : ni outbox, ni ledger, mission toujours DISPUTED.
    expect(await prisma.penaltyDebitOutbox.count({ where: { missionId: mission.id } })).toBe(0)
    expect(await prisma.buyerCompensationOutbox.count({ where: { missionId: mission.id } })).toBe(0)
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({
      where: { missionId: mission.id },
    })
    expect(await prisma.ledgerEntry.count({ where: { escrowId: escrow.id } })).toBe(0)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DISPUTED')
  })

  it('(3) mission non-DISPUTED → 400 ; double arbitrage → 400 sans doublon', async () => {
    const funded = await seedMission('FUNDED')
    const r1 = await arbitrate(funded.id, bearer(adminToken))
    expect(r1.statusCode).toBe(400)
    expect(r1.json()).toEqual({ error: 'MISSION_NOT_DISPUTED' })

    // Double arbitrage : la 1re pose DISPUTED_FRAUD, la 2e est rejetée AVANT toute écriture.
    const mission = await seedMission()
    expect((await arbitrate(mission.id, bearer(adminToken))).statusCode).toBe(200)
    const second = await arbitrate(mission.id, bearer(adminToken))
    expect(second.statusCode).toBe(400)
    expect(second.json()).toEqual({ error: 'MISSION_NOT_DISPUTED' })

    // Exactement une ponction + une compensation + deux lignes de ledger (idempotence anti-TOCTOU).
    expect(await prisma.penaltyDebitOutbox.count({ where: { missionId: mission.id } })).toBe(1)
    expect(await prisma.buyerCompensationOutbox.count({ where: { missionId: mission.id } })).toBe(1)
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({
      where: { missionId: mission.id },
    })
    expect(await prisma.ledgerEntry.count({ where: { escrowId: escrow.id } })).toBe(2)
  })
})
