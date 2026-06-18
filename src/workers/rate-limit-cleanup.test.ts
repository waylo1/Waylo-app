import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { purgeExpiredRateLimits } from './rate-limit-cleanup'

/**
 * Purge des fenêtres de rate-limit expirées — test d'intégration (base réelle
 * waylo_test, comme le reste de la suite). On insère des lignes expirées et
 * fraîches, on purge, et on vérifie que SEULES les expirées disparaissent.
 *
 * Marges de 24 h (passé/futur) : robustes à tout décalage de fuseau entre le
 * `expiresAt` stocké (timestamp) et `NOW()` côté Postgres.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

describe('purgeExpiredRateLimits — nettoyage du store de rate-limit', () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
  })

  beforeEach(async () => {
    await prisma.rateLimit.deleteMany()
  })

  afterAll(async () => {
    await prisma.rateLimit.deleteMany()
    await prisma.$disconnect()
  })

  it('supprime UNIQUEMENT les fenêtres dont expiresAt est dépassé', async () => {
    const past = new Date(Date.now() - 24 * 3600 * 1000) // hier
    const future = new Date(Date.now() + 24 * 3600 * 1000) // demain
    await prisma.rateLimit.createMany({
      data: [
        { key: 'login:203.0.113.0/24:a@x.com', count: 5, expiresAt: past },
        { key: 'login:203.0.113.0/24:b@x.com', count: 9, expiresAt: past },
        { key: 'login:203.0.113.0/24:c@x.com', count: 2, expiresAt: future },
      ],
    })

    const deleted = await purgeExpiredRateLimits()

    expect(deleted).toBe(2)
    const remaining = await prisma.rateLimit.findMany({ select: { key: true } })
    expect(remaining.map(r => r.key)).toEqual(['login:203.0.113.0/24:c@x.com'])
  })

  it("ne supprime rien quand aucune fenêtre n'est expirée", async () => {
    await prisma.rateLimit.create({
      data: { key: 'fresh', count: 1, expiresAt: new Date(Date.now() + 60_000) },
    })

    const deleted = await purgeExpiredRateLimits()

    expect(deleted).toBe(0)
    expect(await prisma.rateLimit.count()).toBe(1)
  })
})
