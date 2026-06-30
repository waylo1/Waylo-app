import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { AppError } from '../errors/app.error'
import {
  getAvailableMatches,
  MATCH_PAGE_LIMIT_MAX,
  MATCHING_OPERATIONAL_DISCLAIMER,
} from './matching.service'

/**
 * matching.service.getAvailableMatches — catalogue global « Net Gain »
 * (DB réelle waylo_test). Couvre :
 *  (1) filtrage status=FUNDED uniquement (MATCHED/CREATED exclus) ;
 *  (2) tri commissionCents desc puis createdAt desc ;
 *  (3) mapping TravelerMatchOffer + disclaimer injecté ;
 *  (4) pagination robuste (hasMore via limit+1, page 2) ;
 *  (5) validation stricte → AppError INVALID_PAGINATION.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const T0 = new Date('2026-06-01T00:00:00.000Z')
const T1 = new Date('2026-06-01T00:10:00.000Z')

describe('matching.service.getAvailableMatches — catalogue Net Gain', () => {
  let prisma: PrismaClient
  let buyerId: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await prisma.escrowTransaction.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.user.deleteMany()

    const buyer = await prisma.user.create({ data: { email: 'buyer-match@test.waylo' } })
    buyerId = buyer.id

    // Récompenses & dates choisies pour fixer l'ordre attendu B > C > A > D ;
    // E (MATCHED) doit être exclu du catalogue.
    await seed('A', 'FUNDED', 5_000, T0)
    await seed('B', 'FUNDED', 9_000, T0) // récompense max → 1er
    await seed('C', 'FUNDED', 5_000, T1) // même reward que A, plus récent → avant A
    await seed('D', 'FUNDED', 1_000, T0) // récompense min → dernier
    await seed('E', 'MATCHED', 50_000, T1) // exclu malgré la plus grosse commission
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function seed(product: string, status: string, commissionCents: number, createdAt: Date) {
    return prisma.mission.create({
      data: {
        buyerId,
        status: status as never,
        targetProduct: product,
        budgetCents: 40_000,
        commissionCents,
        origin: 'Paris',
        destination: 'Tokyo',
        destinationCountry: 'JP',
        createdAt,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
  }

  it('(1)(2) ne retourne que les FUNDED, triées commissionCents desc puis createdAt desc', async () => {
    const { offers } = await getAvailableMatches(1, 10)

    expect(offers.map((o) => o.targetProduct)).toEqual(['B', 'C', 'A', 'D'])
    expect(offers.every((o) => o.targetProduct !== 'E')).toBe(true)
    expect(offers.map((o) => o.travelerRewardCents)).toEqual([9_000, 5_000, 5_000, 1_000])
  })

  it('(3) mappe TravelerMatchOffer et injecte le disclaimer dans chaque offre', async () => {
    const { offers } = await getAvailableMatches(1, 10)
    const top = offers[0]

    expect(top).toMatchObject({
      targetProduct: 'B',
      budgetCents: 40_000,
      travelerRewardCents: 9_000,
      origin: 'Paris',
      destination: 'Tokyo',
      destinationCountryIso: 'JP',
    })
    expect(typeof top.missionId).toBe('string')
    expect(top.createdAt).toBeInstanceOf(Date)
    expect(offers.every((o) => o.operationalDisclaimer === MATCHING_OPERATIONAL_DISCLAIMER)).toBe(true)
  })

  it('(4) pagination robuste : page 1 a hasMore, page 2 termine le catalogue', async () => {
    const p1 = await getAvailableMatches(1, 2)
    expect(p1.offers.map((o) => o.targetProduct)).toEqual(['B', 'C'])
    expect(p1).toMatchObject({ page: 1, limit: 2, hasMore: true })

    const p2 = await getAvailableMatches(2, 2)
    expect(p2.offers.map((o) => o.targetProduct)).toEqual(['A', 'D'])
    expect(p2).toMatchObject({ page: 2, limit: 2, hasMore: false })

    const p3 = await getAvailableMatches(3, 2)
    expect(p3.offers).toEqual([])
    expect(p3.hasMore).toBe(false)
  })

  it('(5) validation stricte → AppError INVALID_PAGINATION (400)', async () => {
    const invalid: Array<[number, number]> = [
      [0, 10], // page < 1
      [-1, 10], // page négatif
      [1.5, 10], // page non entier
      [Number.NaN, 10], // page NaN
      [1, 0], // limit < 1
      [1, MATCH_PAGE_LIMIT_MAX + 1], // limit hors borne
      [1, 2.5], // limit non entier
      [1, Number.NaN], // limit NaN
    ]

    for (const [page, limit] of invalid) {
      await expect(getAvailableMatches(page, limit)).rejects.toSatisfy(
        (e: unknown) => e instanceof AppError && e.code === 'INVALID_PAGINATION' && e.statusCode === 400,
      )
    }
  })
})
