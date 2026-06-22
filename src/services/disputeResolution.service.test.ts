import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'
import {
  openDispute,
  DisputeResolutionError,
  DISPUTE_WINDOW_MS,
} from './disputeResolution.service'

/**
 * DisputeService — litige AUTOMATISÉ (openDispute) :
 * (A) ouverture → IN_DISPUTE + disputeOpenedAt + disputeDeadline (now + 72 h) + reason ;
 * (B) idempotence : re-open = no-op, la deadline N'EST PAS réarmée ;
 * (C) états non litigeables (soldés / arbitrage humain) → MISSION_NOT_DISPUTABLE ;
 * (D) mission inexistante → MISSION_NOT_FOUND.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

describe('DisputeService — litige automatisé (openDispute)', () => {
  let prisma: PrismaClient
  let buyer: User
  let traveler: User

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
  })

  beforeEach(async () => {
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-autodispute@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-autodispute@test.waylo' } })
  })

  afterAll(async () => {
    await resetDb(prisma)
    await prisma.$disconnect()
  })

  async function seedMission(status: MissionStatus): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status,
        targetProduct: 'Article litige auto',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    return mission.id
  }

  it('(A) ouvre le litige : IN_DISPUTE + horodatages + deadline ≈ now + 72 h + reason', async () => {
    const missionId = await seedMission(MissionStatus.DEPOSITED)
    const before = Date.now()

    const mission = await openDispute(missionId, 'Article non conforme')

    expect(mission.status).toBe(MissionStatus.IN_DISPUTE)
    expect(mission.disputeReason).toBe('Article non conforme')
    expect(mission.disputeOpenedAt).toBeInstanceOf(Date)
    expect(mission.disputeDeadline).toBeInstanceOf(Date)

    // disputeDeadline = disputeOpenedAt + 72 h (à la milliseconde près).
    const opened = mission.disputeOpenedAt!.getTime()
    const deadline = mission.disputeDeadline!.getTime()
    expect(deadline - opened).toBe(DISPUTE_WINDOW_MS)
    // Ancrée sur l'horloge serveur (tolérance large pour la latence DB).
    expect(opened).toBeGreaterThanOrEqual(before - 5_000)
    expect(opened).toBeLessThanOrEqual(Date.now() + 5_000)
  })

  it('(A) reason optionnel : openDispute sans motif → disputeReason null', async () => {
    const missionId = await seedMission(MissionStatus.AWAITING_CONFIRMATION)
    const mission = await openDispute(missionId)
    expect(mission.status).toBe(MissionStatus.IN_DISPUTE)
    expect(mission.disputeReason).toBeNull()
  })

  it('(B) idempotent : re-open = no-op et NE réarme PAS la deadline', async () => {
    const missionId = await seedMission(MissionStatus.DEPOSITED)
    const first = await openDispute(missionId, 'motif 1')

    // Deuxième appel (motif différent) : la deadline et le motif d'origine sont conservés.
    const second = await openDispute(missionId, 'motif 2')
    expect(second.status).toBe(MissionStatus.IN_DISPUTE)
    expect(second.disputeDeadline!.getTime()).toBe(first.disputeDeadline!.getTime())
    expect(second.disputeReason).toBe('motif 1')
  })

  it('(C) mission soldée (RELEASED) → MISSION_NOT_DISPUTABLE', async () => {
    const missionId = await seedMission(MissionStatus.RELEASED)
    await expect(openDispute(missionId)).rejects.toThrowError(/MISSION_NOT_DISPUTABLE/)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.status).toBe(MissionStatus.RELEASED) // statut inchangé
  })

  it('(C) mission sous arbitrage humain (DISPUTED) → MISSION_NOT_DISPUTABLE', async () => {
    const missionId = await seedMission(MissionStatus.DISPUTED)
    await expect(openDispute(missionId)).rejects.toThrow(DisputeResolutionError)
  })

  it('(D) mission inexistante → MISSION_NOT_FOUND', async () => {
    await expect(openDispute('mission_inexistante')).rejects.toThrowError(/MISSION_NOT_FOUND/)
  })
})
