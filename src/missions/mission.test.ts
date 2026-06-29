import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'
import type { PaymentIntentClient } from './mission-common'

/**
 * Tests du service mission.service.ts :
 *   1. GET /my-missions — dashboard voyageur (statuts vivants MATCHED→VALIDATED + RELEASED)
 *   2. triggerMissionCreatedNotification — idempotence + NOTIFICATION_FAILED
 *
 * NB : le flux /assign + statut ACTIVE a été supprimé (DEADFLOWS flux c) — les tests
 * d'assignation correspondants ont été retirés. Le matchmaking vivant (/match·/accept)
 * est couvert par mission-matchmaking.test.ts.
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

  it('succès : 2 missions retournées (1 MATCHED en cours + 1 RELEASED terminée)', async () => {
    const traveler = await prisma.user.create({ data: { email: 'dash-success@test.waylo' } })
    const m1 = await createMission(traveler.id, MissionStatus.MATCHED)
    const m2 = await createMission(traveler.id, MissionStatus.RELEASED)

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
    const mA = await createMission(travelerA.id, MissionStatus.MATCHED)
    const mB = await createMission(travelerB.id, MissionStatus.MATCHED)

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

  it('filtre statut : mission CREATED exclue, mission MATCHED incluse', async () => {
    const traveler = await prisma.user.create({ data: { email: 'dash-filter@test.waylo' } })
    const mCreated = await createMission(traveler.id, MissionStatus.CREATED)
    const mMatched = await createMission(traveler.id, MissionStatus.MATCHED)

    const res = await getMyMissions(makeToken(traveler.id))
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ id: string }>
    const ids = body.map(m => m.id)
    expect(ids).not.toContain(mCreated.id)
    expect(ids).toContain(mMatched.id)
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
