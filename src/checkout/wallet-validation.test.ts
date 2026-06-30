import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { validateMissionFunding } from './wallet-validation'

/**
 * Validation de financement au checkout (Sprint 19, src/checkout/wallet-validation.ts).
 *
 * Garde « capacité acheteur » : (autorisation Stripe + solde Wallet) doit atteindre
 * 120% du prix total de la mission (budget + commission), sinon la commande est
 * bloquée (INSUFFICIENT_FUNDS_FOR_MISSION).
 *
 *   BUDGET 10_000 + COMMISSION 2_000 = TOTAL 12_000 → seuil 120% = 14_400.
 *
 * (1) capacité ≥ 120% (autorisation seule)            → PASS
 * (2) Wallet fait basculer la capacité au seuil exact → PASS (prouve la lecture DB du Wallet)
 * (3) capacité < 120% malgré le Wallet                → FAIL INSUFFICIENT_FUNDS_FOR_MISSION
 * (4) aucun Wallet, autorisation insuffisante         → FAIL (solde par défaut 0)
 *
 * Intégration : lit la VRAIE base waylo_test (mission + wallet), comme les autres suites.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 2_000
const TOTAL_CENTS = BUDGET_CENTS + COMMISSION_CENTS // 12_000
const REQUIRED_CENTS = Math.floor((TOTAL_CENTS * 12) / 10) // 14_400 (120%)

describe('Checkout — validation capacité acheteur (Sprint 19)', () => {
  let prisma: PrismaClient
  let buyer: User

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await wipe()
    buyer = await prisma.user.create({
      data: { email: 'buyer-checkout-s19@test.waylo', kycStatus: 'VERIFIED' },
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function wipe(): Promise<void> {
    await prisma.walletTransaction.deleteMany()
    await prisma.wallet.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.mission.deleteMany()
  }

  // Purge missions + wallets entre cas (buyer conservé).
  beforeEach(async () => {
    await prisma.walletTransaction.deleteMany()
    await prisma.wallet.deleteMany()
    await prisma.mission.deleteMany()
  })

  async function seedMission(): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'CREATED',
        targetProduct: 'Article de mission',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    return mission.id
  }

  async function seedWallet(balanceCents: number): Promise<void> {
    await prisma.wallet.create({ data: { userId: buyer.id, balanceCents } })
  }

  it('(1) PASS — autorisation Stripe seule ≥ 120% du total', async () => {
    const missionId = await seedMission()

    const capacity = await validateMissionFunding({
      missionId,
      stripeAuthorizationCents: REQUIRED_CENTS, // 14_400, aucun wallet
    })

    expect(capacity.missionTotalCents).toBe(TOTAL_CENTS)
    expect(capacity.requiredCapacityCents).toBe(REQUIRED_CENTS)
    expect(capacity.walletBalanceCents).toBe(0)
    expect(capacity.totalCapacityCents).toBe(REQUIRED_CENTS)
  })

  it('(2) PASS — le solde Wallet fait basculer la capacité au seuil exact (120%)', async () => {
    const missionId = await seedMission()
    await seedWallet(2_400) // 12_000 (auth) + 2_400 (wallet) = 14_400 = seuil

    const capacity = await validateMissionFunding({
      missionId,
      stripeAuthorizationCents: TOTAL_CENTS, // 12_000 seul < 14_400 ⇒ le wallet est décisif
    })

    expect(capacity.walletBalanceCents).toBe(2_400)
    expect(capacity.totalCapacityCents).toBe(REQUIRED_CENTS) // 14_400, exactement au seuil
  })

  it('(3) FAIL — capacité < 120% malgré le Wallet → INSUFFICIENT_FUNDS_FOR_MISSION', async () => {
    const missionId = await seedMission()
    await seedWallet(1_000) // 12_000 + 1_000 = 13_000 < 14_400

    await expect(
      validateMissionFunding({ missionId, stripeAuthorizationCents: TOTAL_CENTS }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS_FOR_MISSION' })
  })

  it('(4) FAIL — aucun Wallet, autorisation seule insuffisante (solde par défaut 0)', async () => {
    const missionId = await seedMission()

    await expect(
      validateMissionFunding({ missionId, stripeAuthorizationCents: TOTAL_CENTS }), // 12_000 < 14_400
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS_FOR_MISSION' })
  })
})
