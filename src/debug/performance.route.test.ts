import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * GET /debug/performance — endpoint de diagnostic admin (lecture seule).
 *
 * (1) non authentifié → 401 ;
 * (2) non-admin (buyer) → 403 FORBIDDEN ;
 * (3) admin → 200 + payload { collectedAt, prismaPool, workers[], memory{} }.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('GET /debug/performance', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let admin: User
  let buyer: User
  let adminToken: string
  let buyerToken: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()
  })

  beforeEach(async () => {
    await resetDb(prisma)
    admin = await prisma.user.create({ data: { email: 'admin-perf@test.waylo', isAdmin: true } })
    buyer = await prisma.user.create({ data: { email: 'buyer-perf@test.waylo' } })
    adminToken = app.jwt.sign({ sub: admin.id })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/debug/performance', headers })

  it('non authentifié → 401', async () => {
    const res = await get()
    expect(res.statusCode).toBe(401)
  })

  it('non-admin (buyer) → 403 FORBIDDEN', async () => {
    const res = await get({ authorization: `Bearer ${buyerToken}` })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'FORBIDDEN' })
  })

  it('admin → 200 + payload diagnostic complet', async () => {
    const res = await get({ authorization: `Bearer ${adminToken}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.collectedAt).toBe('string')
    expect(Array.isArray(body.workers)).toBe(true)
    expect(typeof body.memory.rss).toBe('number')
    expect(typeof body.memory.heapUsed).toBe('number')
    // prismaPool : { open, busy, idle } si $metrics dispo, sinon null (dégradation gracieuse).
    expect(body.prismaPool === null || typeof body.prismaPool.open === 'number').toBe(true)
  })
})
