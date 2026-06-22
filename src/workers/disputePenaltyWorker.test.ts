import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { AccountStatus, MissionStatus, PenaltyReason, PenaltyStatus } from '../generated/prisma'
import type { PenaltyChargeStripeClient } from './disputePenaltyWorker'
import { resetDb } from '../../tests/helpers/db-reset'
import { runDisputePenaltyWorkerOnce } from './disputePenaltyWorker'

/**
 * disputePenaltyWorker — prélèvement de la pénalité d'instruction (contestation
 * abusive) en INTÉGRATION (DB réelle waylo_test, Stripe mocké) :
 * (A) charge off-session réussie → PAID + PI, compte NON suspendu ;
 * (B) échec terminal → FAILED + compte SUSPENDED + alerte ;
 * (C) moyen de paiement absent → terminal immédiat (FAILED + SUSPENDED, sans appel Stripe) ;
 * (D) échec sous le seuil → reste PENDING, compte NON suspendu (retry au tick suivant) ;
 * (E) idempotence : un PAID n'est jamais re-prélevé.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const mockLog = { info: vi.fn(), error: vi.fn() }

function makeStripe(create: ReturnType<typeof vi.fn>): PenaltyChargeStripeClient {
  return { paymentIntents: { create } } as unknown as PenaltyChargeStripeClient
}

describe('disputePenaltyWorker — prélèvement pénalité d\'instruction', () => {
  let prisma: PrismaClient
  let counter = 0

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb(prisma)
  })

  afterAll(async () => {
    await resetDb(prisma)
    await prisma.$disconnect()
  })

  /** Auteur du litige avec (ou sans) moyen de paiement par défaut. */
  async function seedUser(withPaymentMethod: boolean): Promise<User> {
    counter += 1
    return prisma.user.create({
      data: {
        email: `abuser-${counter}@test.waylo`,
        ...(withPaymentMethod
          ? { stripePaymentMethodId: `pm_${counter}`, stripeCustomerId: `cus_${counter}` }
          : {}),
      },
    })
  }

  /** Pénalité PENDING rattachée à une mission résolue (REFUNDED). */
  async function seedPenalty(user: User): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: user.id,
        status: MissionStatus.REFUNDED,
        targetProduct: 'Article litige abusif',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        isContestAbusive: true,
      },
    })
    const penalty = await prisma.penalty.create({
      data: { missionId: mission.id, userId: user.id, reason: PenaltyReason.ABUSIVE_DISPUTE },
    })
    return penalty.id
  }

  it('(A) charge off-session réussie → PAID + PI, compte NON suspendu', async () => {
    const user = await seedUser(true)
    const penaltyId = await seedPenalty(user)
    const create = vi.fn().mockResolvedValue({ id: 'pi_pen_ok', status: 'succeeded' })

    const res = await runDisputePenaltyWorkerOnce({ prisma, stripe: makeStripe(create), log: mockLog })

    expect(res).toEqual({ paid: 1, failed: 0, suspended: 0 })
    // Charge 150 € (15000 c) off-session sur le moyen de paiement par défaut, clé déterministe.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 15_000,
        currency: 'eur',
        customer: user.stripeCustomerId,
        payment_method: user.stripePaymentMethodId,
        confirm: true,
        off_session: true,
      }),
      { idempotencyKey: `dispute_penalty_${penaltyId}` },
    )
    const penalty = await prisma.penalty.findUniqueOrThrow({ where: { id: penaltyId } })
    expect(penalty.status).toBe(PenaltyStatus.PAID)
    expect(penalty.stripePaymentIntentId).toBe('pi_pen_ok')
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.accountStatus).toBe(AccountStatus.ACTIVE) // pas de suspension sur succès
  })

  it('(B) échec terminal → FAILED + compte SUSPENDED + alerte critique', async () => {
    const user = await seedUser(true)
    const penaltyId = await seedPenalty(user)
    const create = vi.fn().mockRejectedValue(new Error('card_declined'))
    const onAlert = vi.fn()

    const res = await runDisputePenaltyWorkerOnce({
      prisma,
      stripe: makeStripe(create),
      log: mockLog,
      maxAttempts: 1, // 1er échec = terminal
      onAlert,
    })

    expect(res).toEqual({ paid: 0, failed: 0, suspended: 1 })
    const penalty = await prisma.penalty.findUniqueOrThrow({ where: { id: penaltyId } })
    expect(penalty.status).toBe(PenaltyStatus.FAILED)
    expect(penalty.lastError).toContain('card_declined')
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.accountStatus).toBe(AccountStatus.SUSPENDED) // blacklist auto
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DISPUTE_PENALTY_ACCOUNT_SUSPENDED', severity: 'critical' }),
    )
  })

  it('(C) moyen de paiement absent → terminal immédiat (FAILED + SUSPENDED, sans appel Stripe)', async () => {
    const user = await seedUser(false) // pas de stripePaymentMethodId
    const penaltyId = await seedPenalty(user)
    const create = vi.fn()

    const res = await runDisputePenaltyWorkerOnce({
      prisma,
      stripe: makeStripe(create),
      log: mockLog,
      maxAttempts: 5, // pourtant terminal : carte absente = pas de retry possible
    })

    expect(create).not.toHaveBeenCalled()
    expect(res).toEqual({ paid: 0, failed: 0, suspended: 1 })
    const penalty = await prisma.penalty.findUniqueOrThrow({ where: { id: penaltyId } })
    expect(penalty.status).toBe(PenaltyStatus.FAILED)
    expect(penalty.lastError).toContain('DEFAULT_PAYMENT_METHOD_MISSING')
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.accountStatus).toBe(AccountStatus.SUSPENDED)
  })

  it('(D) échec sous le seuil → reste PENDING, compte NON suspendu (retry au tick suivant)', async () => {
    const user = await seedUser(true)
    const penaltyId = await seedPenalty(user)
    const create = vi.fn().mockRejectedValue(new Error('processing_error'))

    const res = await runDisputePenaltyWorkerOnce({
      prisma,
      stripe: makeStripe(create),
      log: mockLog,
      maxAttempts: 3, // 1er échec (attempts=1 < 3) = non terminal
    })

    expect(res).toEqual({ paid: 0, failed: 1, suspended: 0 })
    const penalty = await prisma.penalty.findUniqueOrThrow({ where: { id: penaltyId } })
    expect(penalty.status).toBe(PenaltyStatus.PENDING) // ré-éligible
    expect(penalty.attempts).toBe(1)
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(after.accountStatus).toBe(AccountStatus.ACTIVE) // pas de suspension prématurée
  })

  it('(E) idempotence : un PAID n\'est jamais re-prélevé au tick suivant', async () => {
    const user = await seedUser(true)
    await seedPenalty(user)
    const create = vi.fn().mockResolvedValue({ id: 'pi_pen_once', status: 'succeeded' })
    const deps = { prisma, stripe: makeStripe(create), log: mockLog }

    await runDisputePenaltyWorkerOnce(deps)
    const second = await runDisputePenaltyWorkerOnce(deps)

    expect(create).toHaveBeenCalledTimes(1) // PAID non re-sélectionné
    expect(second).toEqual({ paid: 0, failed: 0, suspended: 0 })
  })
})
