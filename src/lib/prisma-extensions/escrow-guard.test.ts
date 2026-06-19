import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { EscrowStatus, MissionStatus } from '../../generated/prisma'
import { resetDb } from '../../../tests/helpers/db-reset'
import { EscrowImmutableError } from './escrow-guard'

/**
 * Garde d'immutabilité escrow ($extends) — défense en profondeur :
 * (A) toute mutation NON gardée d'un escrow terminal (RELEASED/REFUNDED/CANCELLED) lève ;
 * (B) une transition légitime gardée (where status: HELD) depuis HELD passe ;
 * (C) un rejeu idempotent gardé sur un escrow déjà terminal NE lève PAS (count 0).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

describe('escrow immutability guard ($extends)', () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = (await import('../../db')).prisma
  })

  beforeEach(async () => {
    await resetDb(prisma)
  })

  afterAll(async () => {
    await resetDb(prisma)
    await prisma.$disconnect()
  })

  async function seedEscrow(status: EscrowStatus): Promise<string> {
    const buyer = await prisma.user.create({ data: { email: `escrow-guard-${status}@test.waylo` } })
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: MissionStatus.VALIDATED,
        targetProduct: 'Article test',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    const escrow = await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_guard_${mission.id}`,
        spendingLimitCents: 50_000,
        idempotencyKey: `escrow_guard_${mission.id}`,
        status,
      },
    })
    return escrow.id
  }

  it('(A) rejette update() sur un escrow RELEASED', async () => {
    const id = await seedEscrow(EscrowStatus.RELEASED)
    await expect(
      prisma.escrowTransaction.update({ where: { id }, data: { status: EscrowStatus.CANCELLED } }),
    ).rejects.toThrow(EscrowImmutableError)
  })

  it('(A) rejette updateMany() NON gardé sur un escrow CANCELLED', async () => {
    const id = await seedEscrow(EscrowStatus.CANCELLED)
    await expect(
      prisma.escrowTransaction.updateMany({ where: { id }, data: { status: EscrowStatus.RELEASED } }),
    ).rejects.toThrow(EscrowImmutableError)
    // L'état terminal n'a pas bougé.
    const after = await prisma.escrowTransaction.findUniqueOrThrow({ where: { id } })
    expect(after.status).toBe(EscrowStatus.CANCELLED)
  })

  it('(A) rejette update() sur un escrow REFUNDED', async () => {
    const id = await seedEscrow(EscrowStatus.REFUNDED)
    await expect(
      prisma.escrowTransaction.update({ where: { id }, data: { capturedAmountCents: 1 } }),
    ).rejects.toThrow(EscrowImmutableError)
  })

  it('(B) laisse passer la transition gardée HELD → RELEASED', async () => {
    const id = await seedEscrow(EscrowStatus.HELD)
    const res = await prisma.escrowTransaction.updateMany({
      where: { id, status: EscrowStatus.HELD },
      data: { status: EscrowStatus.RELEASED },
    })
    expect(res.count).toBe(1)
  })

  it('(C) rejeu idempotent gardé sur escrow déjà RELEASED : pas d’exception, count 0', async () => {
    const id = await seedEscrow(EscrowStatus.RELEASED)
    const res = await prisma.escrowTransaction.updateMany({
      where: { id, status: EscrowStatus.HELD },
      data: { status: EscrowStatus.RELEASED },
    })
    expect(res.count).toBe(0)
  })
})
