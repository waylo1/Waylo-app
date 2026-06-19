import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { expireGhostMissions } from './mission-lifecycle'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * Worker cycle de vie — clôture des ghost missions (audit robustesse).
 *
 * Seules les missions CREATED (jamais financées, aucun escrow) dont `expiresAt`
 * est dépassé passent à EXPIRED. Tout autre statut est épargné (argent en jeu).
 * Transition conditionnelle anti-TOCTOU, idempotente, aucun appel Stripe.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const PAST = new Date(Date.now() - 24 * 3600 * 1000)
const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000)

describe('Ghost missions — expireGhostMissions', () => {
  let prisma: PrismaClient
  let buyer: User

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-ghost@test.waylo' } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function seed(status: string, expiresAt: Date): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: status as never,
        targetProduct: 'Mission fantôme',
        budgetCents: 10_000,
        commissionCents: 1_000,
        destination: 'Tokyo',
        expiresAt,
      },
    })
    return mission.id
  }

  it('CREATED expirée → EXPIRED ; future / FUNDED épargnées ; idempotent', async () => {
    const createdPast = await seed('CREATED', PAST)
    const createdFuture = await seed('CREATED', FUTURE)
    const fundedPast = await seed('FUNDED', PAST)

    const n1 = await expireGhostMissions({ prisma })
    expect(n1).toBe(1) // seul createdPast est un fantôme

    const statusOf = async (id: string) =>
      (await prisma.mission.findUniqueOrThrow({ where: { id } })).status
    expect(await statusOf(createdPast)).toBe('EXPIRED')
    expect(await statusOf(createdFuture)).toBe('CREATED') // pas encore expirée
    expect(await statusOf(fundedPast)).toBe('FUNDED') // hors scope : escrow en jeu

    const n2 = await expireGhostMissions({ prisma })
    expect(n2).toBe(0) // idempotent : plus aucun CREATED expiré
  })

  it('borne stricte : expiresAt == now n\'est PAS expirée', async () => {
    const now = new Date()
    await seed('CREATED', now)
    const n = await expireGhostMissions({ prisma, now })
    expect(n).toBe(0) // lt strict — l'instant pile n'expire pas
  })
})
