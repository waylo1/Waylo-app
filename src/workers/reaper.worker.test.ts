import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { MissionStatus, PenaltyReason, PenaltyStatus } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'
import { runReaperOnce } from './reaper.worker'

/**
 * Reaper worker — surveillance des pénalités STUCK_PENDING.
 *
 * (1) Aucune pénalité bloquée → stuckCount=0, aucune alerte.
 * (2) Pénalité STUCK_PENDING (PENDING + attempts≥max) → stuckCount=1 + alerte
 *     DISPUTE_PENALTY_STUCK_PENDING ; alerte contient idempotencyKey, stuckCount,
 *     penaltyId, missionId (dashboard de réconciliation).
 * (3) Pénalité PENDING sous le seuil (attempts<max) → pas détectée (non bloquée).
 * (4) Pénalité FAILED (déjà remédiée) → pas détectée.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const mockLog = { info: vi.fn(), error: vi.fn() }

describe('runReaperOnce — surveillance STUCK_PENDING', () => {
  let prisma: PrismaClient
  let user: User
  let counter = 0

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb(prisma)
    counter += 1
    user = await prisma.user.create({
      data: { email: `reaper-user-${counter}@test.waylo`, stripePaymentMethodId: `pm_${counter}` },
    })
  })

  afterAll(async () => {
    await resetDb(prisma)
    await prisma.$disconnect()
  })

  async function seedMission(): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: user.id,
        status: MissionStatus.REFUNDED,
        targetProduct: 'Article litige reaper',
        budgetCents: 10_000,
        commissionCents: 1_500,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    return mission.id
  }

  async function seedPenalty(missionId: string, status: PenaltyStatus, attempts: number): Promise<string> {
    const penalty = await prisma.penalty.create({
      data: { missionId, userId: user.id, reason: PenaltyReason.ABUSIVE_CONTESTATION, status, attempts },
    })
    return penalty.id
  }

  it('(1) aucune pénalité bloquée → stuckCount=0, aucune alerte', async () => {
    const onAlert = vi.fn()
    const res = await runReaperOnce({ prisma, maxAttempts: 3, onAlert, log: mockLog })

    expect(res).toEqual({ stuckCount: 0 })
    expect(onAlert).not.toHaveBeenCalled()
    expect(mockLog.error).not.toHaveBeenCalled()
  })

  it('(2) pénalité STUCK_PENDING → stuckCount=1 + alerte avec idempotencyKey et détails dashboard', async () => {
    const missionId = await seedMission()
    const penaltyId = await seedPenalty(missionId, PenaltyStatus.PENDING, 3) // attempts=3 >= maxAttempts=3
    const onAlert = vi.fn()

    const res = await runReaperOnce({ prisma, maxAttempts: 3, onAlert, log: mockLog })

    expect(res).toEqual({ stuckCount: 1 })
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ stuckCount: 1, penaltyIds: [penaltyId] }),
      expect.stringContaining('STUCK_PENDING'),
    )
    expect(onAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'DISPUTE_PENALTY_STUCK_PENDING',
        severity: 'critical',
      }),
    )
    // Alerte lisible pour le dashboard : idempotencyKey, stuckCount, penaltyId, missionId.
    const alertCall = onAlert.mock.calls[0][0]
    expect(alertCall.details.stuckCount).toBe(1)
    expect(alertCall.details.maxAttempts).toBe(3)
    const penaltyDetail = alertCall.details.penalties[0]
    expect(penaltyDetail.penaltyId).toBe(penaltyId)
    expect(penaltyDetail.missionId).toBe(missionId)
    expect(penaltyDetail.idempotencyKey).toBe(`dispute_penalty_${penaltyId}`)
    expect(penaltyDetail.amountCents).toBe(15_000)
    // Le reaper ne modifie PAS la DB — il surveille seulement.
    const penalty = await prisma.penalty.findUniqueOrThrow({ where: { id: penaltyId } })
    expect(penalty.status).toBe(PenaltyStatus.PENDING) // inchangé
  })

  it('(3) pénalité PENDING sous le seuil → non détectée (retry normal, pas bloquée)', async () => {
    const missionId = await seedMission()
    await seedPenalty(missionId, PenaltyStatus.PENDING, 2) // attempts=2 < maxAttempts=3
    const onAlert = vi.fn()

    const res = await runReaperOnce({ prisma, maxAttempts: 3, onAlert, log: mockLog })

    expect(res).toEqual({ stuckCount: 0 })
    expect(onAlert).not.toHaveBeenCalled()
  })

  it('(4) pénalité FAILED (déjà remédiée) → non détectée', async () => {
    const missionId = await seedMission()
    await seedPenalty(missionId, PenaltyStatus.FAILED, 5) // FAILED, pas PENDING
    const onAlert = vi.fn()

    const res = await runReaperOnce({ prisma, maxAttempts: 3, onAlert, log: mockLog })

    expect(res).toEqual({ stuckCount: 0 })
    expect(onAlert).not.toHaveBeenCalled()
  })
})
