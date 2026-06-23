import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
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

  it(
    'batching : 120 fantômes clôturés par lots de 50 (3 lots), témoins épargnés, idempotent',
    async () => {
      // Repart d'une base propre : ce cas raisonne sur des comptes globaux.
      await resetDb(prisma)
      const batchBuyer = await prisma.user.create({ data: { email: 'buyer-batch@test.waylo' } })

      const N = 120 // > 2 × batchSize → force au moins 3 itérations (50 + 50 + 20)
      await prisma.mission.createMany({
        data: Array.from({ length: N }, (_, i) => ({
          buyerId: batchBuyer.id,
          status: MissionStatus.CREATED,
          targetProduct: `ghost-${i}`,
          budgetCents: 10_000,
          commissionCents: 1_000,
          destination: 'Tokyo',
          expiresAt: PAST,
        })),
      })
      // Témoins hors scope : une CREATED future + une FUNDED passée (escrow en jeu).
      await seedFor(batchBuyer.id, MissionStatus.CREATED, FUTURE)
      await seedFor(batchBuyer.id, MissionStatus.FUNDED, PAST)

      const n = await expireGhostMissions({ prisma, batchSize: 50 })
      expect(n).toBe(N) // les 120 fantômes, parcourus par lots bornés

      expect(await prisma.mission.count({ where: { status: MissionStatus.EXPIRED } })).toBe(N)
      expect(await prisma.mission.count({ where: { status: MissionStatus.CREATED } })).toBe(1) // future
      expect(await prisma.mission.count({ where: { status: MissionStatus.FUNDED } })).toBe(1) // funded

      // Idempotent : un second passage ne re-clôture rien.
      expect(await expireGhostMissions({ prisma, batchSize: 50 })).toBe(0)
    },
    20_000, // timeout explicite : valide que le batching tient sans dépasser
  )
})

/** Crée une mission de statut/échéance donnés pour un acheteur donné. */
async function seedFor(buyerId: string, status: MissionStatus, expiresAt: Date): Promise<void> {
  const { prisma } = await import('../db')
  await prisma.mission.create({
    data: {
      buyerId,
      status,
      targetProduct: 'témoin',
      budgetCents: 1_000,
      commissionCents: 100,
      destination: 'Osaka',
      expiresAt,
    },
  })
}
