import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { DisputeStatus, MissionStatus } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'
import {
  createDispute,
  openDispute,
  escalateDispute,
  resolveDispute,
  closeDispute,
  getDispute,
  DisputeError,
} from './dispute.service'

/**
 * DisputeService — cycle de vie immuable + garde-fous (miroir escrow) :
 * (A) DRAFT→OPEN→ESCALATED→RESOLVED→CLOSED ; (B) idempotence (création + transitions) ;
 * (C) transition illégale → DISPUTE_INVALID_STATE ; immutabilité de CLOSED ;
 * (D) OWASP : tiers → MISSION_NOT_FOUND (404 masquant), non-admin → FORBIDDEN.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

describe('DisputeService — cycle de vie immuable', () => {
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let stranger: User
  let admin: User

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
  })

  beforeEach(async () => {
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-dispute@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-dispute@test.waylo' } })
    stranger = await prisma.user.create({ data: { email: 'stranger-dispute@test.waylo' } })
    admin = await prisma.user.create({ data: { email: 'admin-dispute@test.waylo', isAdmin: true } })
  })

  afterAll(async () => {
    await resetDb(prisma)
    await prisma.$disconnect()
  })

  async function seedMission(): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: MissionStatus.DEPOSITED,
        targetProduct: 'Article litige',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    return mission.id
  }

  it('(A) cycle complet DRAFT → OPEN → ESCALATED → RESOLVED → CLOSED', async () => {
    const missionId = await seedMission()
    expect((await createDispute({ missionId, actorId: buyer.id, reason: 'x' })).status).toBe(
      DisputeStatus.DRAFT,
    )
    expect((await openDispute({ missionId, actorId: buyer.id })).status).toBe(DisputeStatus.OPEN)
    expect((await escalateDispute({ missionId, actorId: traveler.id })).status).toBe(
      DisputeStatus.ESCALATED,
    )
    expect((await resolveDispute({ missionId, actorId: admin.id, resolution: 'ok' })).status).toBe(
      DisputeStatus.RESOLVED,
    )
    expect((await closeDispute({ missionId, actorId: admin.id })).status).toBe(DisputeStatus.CLOSED)
  })

  it('(B) idempotence : double createDispute → un seul litige ; re-open → no-op', async () => {
    const missionId = await seedMission()
    const a = await createDispute({ missionId, actorId: buyer.id })
    const b = await createDispute({ missionId, actorId: buyer.id })
    expect(b.id).toBe(a.id)
    expect(await prisma.dispute.count({ where: { missionId } })).toBe(1)

    await openDispute({ missionId, actorId: buyer.id })
    expect((await openDispute({ missionId, actorId: buyer.id })).status).toBe(DisputeStatus.OPEN)
  })

  it('(C) transition illégale → DISPUTE_INVALID_STATE ; CLOSED immuable', async () => {
    const missionId = await seedMission()
    await createDispute({ missionId, actorId: buyer.id })
    // close depuis DRAFT (saut d'états) → invalide
    await expect(closeDispute({ missionId, actorId: admin.id })).rejects.toThrow(DisputeError)

    await openDispute({ missionId, actorId: buyer.id })
    await resolveDispute({ missionId, actorId: admin.id })
    await closeDispute({ missionId, actorId: admin.id })
    // toute transition depuis CLOSED échoue (immuable)
    await expect(escalateDispute({ missionId, actorId: traveler.id })).rejects.toThrow(DisputeError)
  })

  it('(D) OWASP : tiers → MISSION_NOT_FOUND ; non-admin resolve → FORBIDDEN', async () => {
    const missionId = await seedMission()
    await createDispute({ missionId, actorId: buyer.id })
    await openDispute({ missionId, actorId: buyer.id })

    await expect(createDispute({ missionId, actorId: stranger.id })).rejects.toThrowError(
      /MISSION_NOT_FOUND/,
    )
    // le voyageur n'est pas l'acheteur : ne peut pas ouvrir (404 masquant)
    await expect(openDispute({ missionId, actorId: traveler.id })).rejects.toThrowError(
      /MISSION_NOT_FOUND/,
    )
    await expect(resolveDispute({ missionId, actorId: buyer.id })).rejects.toThrowError(/FORBIDDEN/)
  })

  it('(D) lecture réservée aux participants', async () => {
    const missionId = await seedMission()
    await createDispute({ missionId, actorId: buyer.id })
    expect((await getDispute({ missionId, actorId: traveler.id })).missionId).toBe(missionId)
    await expect(getDispute({ missionId, actorId: stranger.id })).rejects.toThrowError(
      /MISSION_NOT_FOUND/,
    )
  })
})
