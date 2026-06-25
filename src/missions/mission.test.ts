import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'

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
