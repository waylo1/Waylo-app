import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { deleteAccount, AccountDeletionBlockedError } from './userService'

/**
 * userService.deleteAccount — garde anti-suppression (DB réelle waylo_test).
 *  (1) acheteur d'une mission AWAITING_CONFIRMATION → suppression bloquée ;
 *  (2) voyageur d'une mission AWAITING_CONFIRMATION → suppression bloquée ;
 *  (3) utilisateur sans mission bloquante → suppression effectuée.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

describe('userService.deleteAccount — garde anti-suppression', () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await prisma.outboxEvent.deleteMany()
    await prisma.receiptExtractionOutbox.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.user.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function seedAwaitingMission(buyerId: string, travelerId: string) {
    return prisma.mission.create({
      data: {
        buyerId,
        travelerId,
        status: 'AWAITING_CONFIRMATION',
        targetProduct: 'Article',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  it('(1) acheteur d’une mission AWAITING_CONFIRMATION → bloqué', async () => {
    const buyer = await prisma.user.create({ data: { email: 'buyer-del@test.waylo' } })
    const traveler = await prisma.user.create({ data: { email: 'trav-del@test.waylo' } })
    await seedAwaitingMission(buyer.id, traveler.id)

    await expect(deleteAccount(buyer.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AccountDeletionBlockedError && e.code === 'MISSION_AWAITING_CONFIRMATION',
    )
    // Le compte n'est PAS supprimé.
    expect(await prisma.user.findUnique({ where: { id: buyer.id } })).not.toBeNull()
  })

  it('(2) voyageur d’une mission AWAITING_CONFIRMATION → bloqué', async () => {
    const traveler = await prisma.user.findFirstOrThrow({ where: { email: 'trav-del@test.waylo' } })

    await expect(deleteAccount(traveler.id)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof AccountDeletionBlockedError && e.code === 'MISSION_AWAITING_CONFIRMATION',
    )
  })

  it('(3) utilisateur sans mission bloquante → supprimé', async () => {
    const lone = await prisma.user.create({ data: { email: 'lone-del@test.waylo' } })

    await deleteAccount(lone.id)

    expect(await prisma.user.findUnique({ where: { id: lone.id } })).toBeNull()
  })
})
