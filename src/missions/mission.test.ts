import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'
import type { PaymentIntentClient } from './mission-common'

/**
 * Tests unitaires du service mission.service.ts :
 *   1. runAlias appelé avec name='mission-created' et opts.idempotencyKey === missionId
 *   2. Idempotence : 2 appels triggerMissionCreatedNotification même id → notify 1 fois
 *   3. WatchdogExhaustedError → mission.status === NOTIFICATION_FAILED en DB réelle
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

// Mocker @waylo/shared/automation AVANT tout import du service
// WatchdogExhaustedError est conservée depuis le module réel (instanceof check en service)
vi.mock('@waylo/shared/automation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waylo/shared/automation')>()
  return {
    ...actual,
    runAlias: vi.fn().mockResolvedValue(undefined),
  }
})

import * as automation from '@waylo/shared/automation'
import { triggerMissionCreatedNotification } from './mission.service'

import { randomUUID } from 'node:crypto'
const nextId = (): string => `cmtest${randomUUID().replace(/-/g, '')}`

// ---------------------------------------------------------------------------
// [MISSION-ASSIGN-01] POST /api/missions/:id/assign
// ---------------------------------------------------------------------------

describe('[MISSION-ASSIGN-01] POST /missions/:id/assign', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let traveler2: User
  let buyerToken: string
  let travelerToken: string
  let traveler2Token: string

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async () => ({ id: 'pi_fake', client_secret: 'secret' }),
      capture: async (id) => ({ id }),
    },
  }

  const makeMission = async () =>
    prisma.mission.create({
      data: {
        buyerId: buyer.id,
        targetProduct: 'Article test assign',
        budgetCents: 5_000,
        commissionCents: 500,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

  const assign = (missionId: string, token: string) =>
    app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/assign`,
      headers: { authorization: `Bearer ${token}` },
    })

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })
    await resetDb(prisma)
    buyer    = await prisma.user.create({ data: { email: 'assign-buyer@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'assign-traveler@test.waylo' } })
    traveler2 = await prisma.user.create({ data: { email: 'assign-traveler2@test.waylo' } })
    buyerToken    = app.jwt.sign({ sub: buyer.id })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    traveler2Token = app.jwt.sign({ sub: traveler2.id })
  })

  afterAll(async () => {
    await app.close()
  })

  it('succès : 200 + status ACTIVE', async () => {
    const mission = await makeMission()
    const res = await assign(mission.id, travelerToken)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: MissionStatus.ACTIVE })
    const updated = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(updated.status).toBe(MissionStatus.ACTIVE)
    expect(updated.travelerId).toBe(traveler.id)
  })

  it('idempotent séquentiel : 2e appel du même voyageur → 200 (pas 409)', async () => {
    const mission = await makeMission()
    const r1 = await assign(mission.id, travelerToken)
    const r2 = await assign(mission.id, travelerToken)
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    const event = await prisma.processedAssignmentEvent.findUnique({ where: { missionId: mission.id } })
    expect(event?.travelerId).toBe(traveler.id)
  })

  it('concurrence : Promise.all → exactement 1×200 et 1×409', async () => {
    // MOTEUR : PostgreSQL local (localhost:5433/waylo_test) — row-level lock réel.
    // Le guard est le WHERE status='CREATED' de l'updateMany : sans cette clause,
    // les deux requêtes obtiendraient count=1 et retourneraient 2×200 (vérifié
    // manuellement : retirer le WHERE → 2×200, le remettre → 1×200+1×409).
    const mission = await makeMission()
    const [r1, r2] = await Promise.all([
      assign(mission.id, travelerToken),
      assign(mission.id, travelerToken),
    ])
    const codes = [r1.statusCode, r2.statusCode].sort((a, b) => a - b)
    expect(codes).toEqual([200, 409])

    // Invariant post-race : une seule écriture a réussi — état DB cohérent.
    const events = await prisma.processedAssignmentEvent.findMany({
      where: { missionId: mission.id },
    })
    expect(events).toHaveLength(1)
    const updated = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(updated.status).toBe(MissionStatus.ACTIVE)
    expect(updated.travelerId).toBe(traveler.id)
  })

  it('404 : mission inexistante', async () => {
    const res = await assign('cm_inexistant_000000000000', travelerToken)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'MISSION_NOT_FOUND' })
  })

  it("403 : le buyer ne peut pas s'auto-assigner", async () => {
    const mission = await makeMission()
    const res = await assign(mission.id, buyerToken)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toMatchObject({ error: 'FORBIDDEN' })
  })

  it("409 : autre voyageur tente d'assigner une mission deja ACTIVE", async () => {
    const mission = await makeMission()
    // traveler1 assigne en premier
    const r1 = await assign(mission.id, travelerToken)
    expect(r1.statusCode).toBe(200)
    // traveler2 tente : ProcessedAssignmentEvent existe avec travelerId ≠ traveler2
    // → pas de retour 200 idempotent → entre en tx → updateMany count=0 → 409
    const r2 = await assign(mission.id, traveler2Token)
    expect(r2.statusCode).toBe(409)
    expect(r2.json()).toMatchObject({ error: 'MISSION_CONFLICT' })
  })
})

// ---------------------------------------------------------------------------
// [MISSION-02] GET /api/missions/my-missions — dashboard voyageur
// ---------------------------------------------------------------------------

describe('[MISSION-02] GET /missions/my-missions', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async () => ({ id: 'pi_fake', client_secret: 'secret' }),
      capture: async (id) => ({ id }),
    },
  }

  const makeToken = (userId: string) => app.jwt.sign({ sub: userId })

  const createMission = async (travelerId: string, status: MissionStatus) =>
    prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId,
        status,
        targetProduct: 'Dashboard test product',
        budgetCents: 5_000,
        commissionCents: 500,
        origin: 'Paris',
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

  const getMyMissions = (token: string) =>
    app.inject({
      method: 'GET',
      url: '/api/missions/my-missions',
      headers: { authorization: `Bearer ${token}` },
    })

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'dashboard-buyer@test.waylo' } })
  })

  afterAll(async () => {
    await app.close()
  })

  it('succès : 2 missions retournées (1 ACTIVE + 1 COMPLETED_BY_BUYER)', async () => {
    const traveler = await prisma.user.create({ data: { email: 'dash-success@test.waylo' } })
    const m1 = await createMission(traveler.id, MissionStatus.ACTIVE)
    const m2 = await createMission(traveler.id, MissionStatus.COMPLETED_BY_BUYER)

    const res = await getMyMissions(makeToken(traveler.id))
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string; status: string }>
    const ids = body.map(m => m.id)
    expect(body).toHaveLength(2)
    expect(ids).toContain(m1.id)
    expect(ids).toContain(m2.id)
  })

  it('isolement : voyageur A ne voit aucune mission du voyageur B', async () => {
    const travelerA = await prisma.user.create({ data: { email: 'dash-iso-a@test.waylo' } })
    const travelerB = await prisma.user.create({ data: { email: 'dash-iso-b@test.waylo' } })
    const mA = await createMission(travelerA.id, MissionStatus.ACTIVE)
    const mB = await createMission(travelerB.id, MissionStatus.ACTIVE)

    const res = await getMyMissions(makeToken(travelerA.id))
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string; travelerId: string }>
    const ids = body.map(m => m.id)
    expect(ids).toContain(mA.id)
    expect(ids).not.toContain(mB.id)
    for (const m of body) {
      expect(m.travelerId).toBe(travelerA.id)
    }
  })

  it('filtre statut : mission CREATED exclue des résultats', async () => {
    const traveler = await prisma.user.create({ data: { email: 'dash-filter@test.waylo' } })
    const mCreated = await createMission(traveler.id, MissionStatus.CREATED)
    const mActive = await createMission(traveler.id, MissionStatus.ACTIVE)

    const res = await getMyMissions(makeToken(traveler.id))
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string }>
    const ids = body.map(m => m.id)
    expect(ids).not.toContain(mCreated.id)
    expect(ids).toContain(mActive.id)
  })
})

// ---------------------------------------------------------------------------
// [MISSION-01] mission.service — notification lifecycle
// ---------------------------------------------------------------------------

describe('[MISSION-01] mission.service — notification lifecycle', () => {
  let prisma: PrismaClient
  let buyer: User

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'mission-service-test@test.waylo' } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("runAlias appelé avec name='mission-created' et opts.idempotencyKey === missionId", async () => {
    const missionId = nextId()
    const mockNotify = vi.fn().mockResolvedValue(undefined)

    await triggerMissionCreatedNotification(missionId, mockNotify)

    expect(automation.runAlias).toHaveBeenCalledTimes(1)
    expect(automation.runAlias).toHaveBeenCalledWith(
      'mission-created',
      expect.any(Function),
      expect.objectContaining({ idempotencyKey: missionId }),
    )
  })

  it('idempotence : 2 appels même missionId → runAlias appelé 1 seule fois', async () => {
    const missionId = nextId()
    const mockNotify = vi.fn().mockResolvedValue(undefined)

    await triggerMissionCreatedNotification(missionId, mockNotify)
    await triggerMissionCreatedNotification(missionId, mockNotify)

    // Le 2ème appel détecte ProcessedMissionEvent existant → retour early, pas de 2ème runAlias
    expect(automation.runAlias).toHaveBeenCalledTimes(1)
  })

  it('WatchdogExhaustedError → mission.status === NOTIFICATION_FAILED en DB', async () => {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        targetProduct: 'Article watchdog-test',
        budgetCents: 10_000,
        commissionCents: 1_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    vi.mocked(automation.runAlias).mockRejectedValueOnce(
      new automation.WatchdogExhaustedError(
        `mission-created:${mission.id}`,
        4,
        new Error('simulated timeout'),
        [],
      ),
    )

    const mockNotify = vi.fn()
    await triggerMissionCreatedNotification(mission.id, mockNotify)

    const updated = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(updated.status).toBe(MissionStatus.NOTIFICATION_FAILED)
  })
})
