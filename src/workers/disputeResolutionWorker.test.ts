import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { DeliveryProofStatus, EscrowStatus, MissionStatus } from '../generated/prisma'
import type { PaymentIntentClient } from '../missions/mission-common'
import { resetDb } from '../../tests/helpers/db-reset'
import { runDisputeResolutionWorkerOnce, verifyAbuse } from './disputeResolutionWorker'

/**
 * DisputeResolutionWorker (litige automatisé) — test d'INTÉGRATION (DB réelle
 * waylo_test, Stripe mocké) : enqueue + refund réel via outbox, idempotence,
 * retry sur échec Stripe.
 *
 * NB : le bloc d'intégration « garde IN_DISPUTE de escrowPayoutWorker » a été
 * retiré — escrowPayoutWorker supprimé (DEADFLOWS flux b).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const mockLog = { info: vi.fn(), error: vi.fn() }

/** Stub Stripe minimal : seule `paymentIntents.cancel` est exercée par le refund. */
function makeStripe(cancel: ReturnType<typeof vi.fn>): PaymentIntentClient {
  return { paymentIntents: { cancel } } as unknown as PaymentIntentClient
}

describe('DisputeResolutionWorker — refund automatisé via outbox', () => {
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let counter = 0

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-drworker@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-drworker@test.waylo' } })
  })

  afterAll(async () => {
    await resetDb(prisma)
    await prisma.$disconnect()
  })

  /** Mission IN_DISPUTE + escrow HELD. `deadline` pilote l'éligibilité au refund.
   *  `deliveryProofStatus` conditionne la pénalité d'instruction (VALIDATED = abusif). */
  async function seedDisputedMission(
    deadline: Date,
    deliveryProofStatus: DeliveryProofStatus = DeliveryProofStatus.PENDING,
  ): Promise<{ missionId: string; piId: string }> {
    counter += 1
    const piId = `pi_dispute_${counter}`
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: MissionStatus.IN_DISPUTE,
        targetProduct: 'Article litige worker',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        disputeOpenedAt: new Date(deadline.getTime() - 72 * 3600 * 1000),
        disputeDeadline: deadline,
        deliveryProofStatus,
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: piId,
        spendingLimitCents: 50_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return { missionId: mission.id, piId }
  }

  it('échéance dépassée + escrow HELD → enqueue + cancel Stripe → REFUNDED', async () => {
    const { missionId, piId } = await seedDisputedMission(new Date(Date.now() - 1_000))
    const cancel = vi.fn().mockResolvedValue({ id: piId })

    const res = await runDisputeResolutionWorkerOnce({
      prisma,
      stripe: makeStripe(cancel),
      log: mockLog,
    })

    expect(res).toEqual({ enqueued: 1, refunded: 1, failed: 0 })

    // Annulation Stripe HORS tx, clé d'idempotence déterministe par mission.
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith(piId, {}, { idempotencyKey: `dispute_refund_${missionId}` })

    // Effets DB : mission remboursée, hold annulé, outbox soldé.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe(MissionStatus.REFUNDED)
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId } })
    expect(escrow.status).toBe(EscrowStatus.CANCELLED)
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { missionId, type: 'READY_FOR_REFUND' },
    })
    expect(event.status).toBe('SETTLED')

    // Résultat journalisé (« loguer le résultat »).
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ missionId, stripePaymentIntentId: piId }),
      expect.stringContaining('refund Stripe exécuté'),
    )
  })

  it('deliveryProofStatus VALIDATED → pénalité PENDING + AdminAuditLog INSTRUCTION_PENALTY_OPENED', async () => {
    const { missionId, piId } = await seedDisputedMission(
      new Date(Date.now() - 1_000),
      DeliveryProofStatus.VALIDATED,
    )
    const cancel = vi.fn().mockResolvedValue({ id: piId })

    const res = await runDisputeResolutionWorkerOnce({
      prisma,
      stripe: makeStripe(cancel),
      log: mockLog,
    })

    expect(res).toEqual({ enqueued: 1, refunded: 1, failed: 0 })
    // Refund toujours exécuté (la pénalité est un frais d'instruction INDÉPENDANT).
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe(MissionStatus.REFUNDED)
    // Pénalité PENDING créée pour l'AUTEUR du litige (acheteur), montant fixe 15000 c.
    const penalty = await prisma.penalty.findUniqueOrThrow({ where: { missionId } })
    expect(penalty.status).toBe('PENDING')
    expect(penalty.userId).toBe(buyer.id)
    expect(penalty.amountCents).toBe(15_000)
    expect(penalty.reason).toBe('ABUSIVE_CONTESTATION')
    // AdminAuditLog SYSTÈME (adminId null) — isolation totale des logs d'instruction.
    const auditLog = await prisma.adminAuditLog.findFirst({
      where: { missionId, action: 'INSTRUCTION_PENALTY_OPENED' },
    })
    expect(auditLog).not.toBeNull()
    expect(auditLog!.adminId).toBeNull()
    expect(auditLog!.actor).toBe('SYSTEM') // discriminant stable (pas dérivé de adminId null)
  })

  it('verifyAbuse — PENDING → false, VALIDATED → true, REJECTED → false', async () => {
    const { missionId: mPending } = await seedDisputedMission(
      new Date(Date.now() + 3_600_000),
      DeliveryProofStatus.PENDING,
    )
    const { missionId: mValidated } = await seedDisputedMission(
      new Date(Date.now() + 3_600_000),
      DeliveryProofStatus.VALIDATED,
    )
    const { missionId: mRejected } = await seedDisputedMission(
      new Date(Date.now() + 3_600_000),
      DeliveryProofStatus.REJECTED,
    )

    expect(await verifyAbuse(prisma, mPending)).toBe(false)
    expect(await verifyAbuse(prisma, mValidated)).toBe(true)
    expect(await verifyAbuse(prisma, mRejected)).toBe(false)
  })

  it('litige de BONNE FOI (deliveryProofStatus PENDING) → AUCUNE pénalité', async () => {
    const { missionId, piId } = await seedDisputedMission(
      new Date(Date.now() - 1_000),
      DeliveryProofStatus.PENDING,
    )
    const cancel = vi.fn().mockResolvedValue({ id: piId })

    await runDisputeResolutionWorkerOnce({ prisma, stripe: makeStripe(cancel), log: mockLog })

    expect(await prisma.penalty.count({ where: { missionId } })).toBe(0)
    expect(await prisma.adminAuditLog.count({ where: { missionId, action: 'INSTRUCTION_PENALTY_OPENED' } })).toBe(0)
  })

  it('échéance NON dépassée → aucun enqueue, aucun refund, mission reste IN_DISPUTE', async () => {
    const { missionId } = await seedDisputedMission(new Date(Date.now() + 3_600_000))
    const cancel = vi.fn()

    const res = await runDisputeResolutionWorkerOnce({
      prisma,
      stripe: makeStripe(cancel),
      log: mockLog,
    })

    expect(res).toEqual({ enqueued: 0, refunded: 0, failed: 0 })
    expect(cancel).not.toHaveBeenCalled()
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe(MissionStatus.IN_DISPUTE)
    expect(await prisma.outboxEvent.count({ where: { missionId } })).toBe(0)
  })

  it('idempotent : deux ticks → un seul refund (ni double enqueue ni double cancel)', async () => {
    const { missionId, piId } = await seedDisputedMission(new Date(Date.now() - 1_000))
    const cancel = vi.fn().mockResolvedValue({ id: piId })
    const deps = { prisma, stripe: makeStripe(cancel), log: mockLog }

    const first = await runDisputeResolutionWorkerOnce(deps)
    const second = await runDisputeResolutionWorkerOnce(deps)

    expect(first).toEqual({ enqueued: 1, refunded: 1, failed: 0 })
    expect(second).toEqual({ enqueued: 0, refunded: 0, failed: 0 })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(await prisma.outboxEvent.count({ where: { missionId, type: 'READY_FOR_REFUND' } })).toBe(1)
  })

  it('échec Stripe → retry : event PENDING, mission reste IN_DISPUTE, hold intact', async () => {
    const { missionId } = await seedDisputedMission(new Date(Date.now() - 1_000))
    const cancel = vi.fn().mockRejectedValue(new Error('stripe timeout'))

    const res = await runDisputeResolutionWorkerOnce({
      prisma,
      stripe: makeStripe(cancel),
      log: mockLog,
    })

    expect(res).toEqual({ enqueued: 1, refunded: 0, failed: 1 })
    expect(cancel).toHaveBeenCalledTimes(1)

    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe(MissionStatus.IN_DISPUTE) // gelée → payout toujours bloqué
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId } })
    expect(escrow.status).toBe(EscrowStatus.HELD) // hold intact
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { missionId, type: 'READY_FOR_REFUND' },
    })
    expect(event.status).toBe('PENDING') // ré-éligible au prochain tick
    expect(event.lastError).toContain('stripe timeout')
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ worker: 'disputeResolutionWorker', missionId }),
      expect.stringContaining('retry'),
    )
  })
})

// Bloc d'intégration « EscrowPayoutWorker — garde IN_DISPUTE » retiré : le worker
// escrowPayoutWorker a été supprimé (DEADFLOWS flux b). Le gel du payout pendant
// IN_DISPUTE n'a plus d'objet (plus aucun chemin READY_FOR_PAYOUT en prod).
