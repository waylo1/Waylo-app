import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'

/**
 * Réconciliation des financements abandonnés — runFundingReconciliationOnce :
 * (A) PI non autorisé (requires_payment_method), vieux > 30 min → rollback
 *     (escrow CANCELLED, mission CREATED, PI annulé) ;
 * (B) PI 'requires_capture' (séquestre légitime), vieux → INTACT (jamais rollback) ;
 * (C) PI non autorisé mais RÉCENT (< 30 min) → INTACT (fenêtre de grâce).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

describe('Réconciliation financements abandonnés', () => {
  let prisma: PrismaClient
  let buyer: User
  const piStatus: Record<string, string> = {}
  const cancelCalls: string[] = []

  // Fake Stripe : statut du PI piloté par test, enregistre les annulations.
  const fakeStripe = {
    paymentIntents: {
      retrieve: async (id: string) => ({ status: piStatus[id] ?? 'requires_payment_method' }),
      cancel: async (id: string) => {
        cancelCalls.push(id)
        return { id }
      },
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await prisma.escrowTransaction.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.user.deleteMany()
    buyer = await prisma.user.create({ data: { email: 'buyer-fundingrecon@test.waylo' } })
  })

  beforeEach(() => {
    cancelCalls.length = 0
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function seed(opts: {
    pi: string
    piStatusVal: string
    ageMs: number
    missionStatus?: 'FUNDED' | 'CREATED'
  }): Promise<string> {
    piStatus[opts.pi] = opts.piStatusVal
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: opts.missionStatus ?? 'FUNDED',
        targetProduct: 'Article financé',
        budgetCents: 10_000,
        commissionCents: 1_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: opts.pi,
        spendingLimitCents: 10_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
        createdAt: new Date(Date.now() - opts.ageMs),
      },
    })
    return mission.id
  }

  it('annule le financement abandonné (PI non autorisé, > 30 min)', async () => {
    const { runFundingReconciliationOnce } = await import('./funding-reconciliation')
    const abandoned = await seed({
      pi: 'pi_abandoned',
      piStatusVal: 'requires_payment_method',
      ageMs: 60 * 60 * 1000, // 1 h
    })
    const legit = await seed({
      pi: 'pi_held_legit',
      piStatusVal: 'requires_capture', // séquestre autorisé légitime
      ageMs: 60 * 60 * 1000,
    })
    const recent = await seed({
      pi: 'pi_recent',
      piStatusVal: 'requires_payment_method',
      ageMs: 5 * 60 * 1000, // 5 min < 30 min
    })

    const result = await runFundingReconciliationOnce({ prisma, stripe: fakeStripe })

    expect(result.rolledBack).toBe(1)
    expect(result.cancelFailed).toBe(0)
    expect(cancelCalls).toEqual(['pi_abandoned'])

    // (A) abandonné : escrow CANCELLED, mission CREATED.
    expect(
      (await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId: abandoned } }))
        .status,
    ).toBe('CANCELLED')
    expect(
      (await prisma.mission.findUniqueOrThrow({ where: { id: abandoned } })).status,
    ).toBe('CREATED')

    // (B) séquestre légitime : INTACT.
    expect(
      (await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId: legit } })).status,
    ).toBe('HELD')
    expect((await prisma.mission.findUniqueOrThrow({ where: { id: legit } })).status).toBe(
      'FUNDED',
    )

    // (C) récent : INTACT (fenêtre de grâce).
    expect(
      (await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId: recent } })).status,
    ).toBe('HELD')
    expect((await prisma.mission.findUniqueOrThrow({ where: { id: recent } })).status).toBe(
      'FUNDED',
    )
  })

  it('relancé : plus rien à annuler (idempotent)', async () => {
    const { runFundingReconciliationOnce } = await import('./funding-reconciliation')
    const result = await runFundingReconciliationOnce({ prisma, stripe: fakeStripe })
    expect(result.rolledBack).toBe(0)
    expect(cancelCalls).toEqual([])
  })
})
