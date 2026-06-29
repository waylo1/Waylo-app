import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient, User } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'
import { triggerAutoRefundWatchdog } from './disputeResolution.service'

/**
 * triggerAutoRefundWatchdog (intégration DB réelle waylo_test, notifs mockées) :
 * (A) IN_PROGRESS + deadline passée + sceau QR + pas de preuve → gelé en IN_DISPUTE ;
 * (B) deadline non atteinte → aucune transition ;
 * (C) fairness — dropoffReceiptUrl présent → pas de gel ;
 * (D) fairness — dropOffTrackingId présent → pas de gel ;
 * (E) pas de sceau QR (innerQrCodeHash null) → pas de gel ;
 * (F) idempotence — déjà IN_DISPUTE → aucune double transition ;
 * (G) horloge injectable — now dans le futur force la sélection.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

vi.mock('../notifications/notification.service', () => ({
  notifyActor: vi.fn().mockResolvedValue(undefined),
}))

describe('triggerAutoRefundWatchdog', () => {
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let counter = 0

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    await resetDb(prisma)
    buyer = await prisma.user.create({ data: { email: 'buyer-watchdog@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-watchdog@test.waylo' } })
  })

  afterAll(async () => {
    await resetDb(prisma)
    await prisma.$disconnect()
  })

  async function seedMission(opts: {
    status?: MissionStatus
    autoRefundDeadline?: Date | null
    innerQrCodeHash?: string | null
    dropoffReceiptUrl?: string | null
    dropOffTrackingId?: string | null
  } = {}): Promise<string> {
    counter += 1
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: opts.status ?? MissionStatus.IN_PROGRESS,
        targetProduct: `Article watchdog ${counter}`,
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        // Par défaut : deadline passée + sceau posé + aucune preuve voyageur → éligible.
        autoRefundDeadline:
          opts.autoRefundDeadline !== undefined
            ? opts.autoRefundDeadline
            : new Date(Date.now() - 1_000),
        innerQrCodeHash:
          opts.innerQrCodeHash !== undefined ? opts.innerQrCodeHash : 'abc123seal',
        dropoffReceiptUrl: opts.dropoffReceiptUrl ?? null,
        dropOffTrackingId: opts.dropOffTrackingId ?? null,
      },
    })
    return mission.id
  }

  it('(A) IN_PROGRESS + deadline passée + sceau + pas de preuve → IN_DISPUTE', async () => {
    const id = await seedMission()

    const count = await triggerAutoRefundWatchdog({ prisma })

    expect(count).toBe(1)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe(MissionStatus.IN_DISPUTE)
    expect(mission.disputeOpenedAt).toBeInstanceOf(Date)
    expect(mission.disputeDeadline).toBeInstanceOf(Date)
    // disputeDeadline = now (immédiatement éligible à la CONSUME phase).
    expect(mission.disputeDeadline!.getTime()).toBeLessThanOrEqual(Date.now() + 500)
  })

  it('(B) deadline non atteinte → aucune transition', async () => {
    const id = await seedMission({ autoRefundDeadline: new Date(Date.now() + 3_600_000) })

    const count = await triggerAutoRefundWatchdog({ prisma })

    expect(count).toBe(0)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe(MissionStatus.IN_PROGRESS)
  })

  it('(C) fairness — dropoffReceiptUrl présent → pas de gel (preuve de dépôt voyageur)', async () => {
    const id = await seedMission({ dropoffReceiptUrl: 'https://cdn.example.com/receipt.jpg' })

    const count = await triggerAutoRefundWatchdog({ prisma })

    expect(count).toBe(0)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe(MissionStatus.IN_PROGRESS)
  })

  it('(D) fairness — dropOffTrackingId présent → pas de gel (suivi logistique)', async () => {
    const id = await seedMission({ dropOffTrackingId: 'TRACK123' })

    const count = await triggerAutoRefundWatchdog({ prisma })

    expect(count).toBe(0)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe(MissionStatus.IN_PROGRESS)
  })

  it('(E) pas de sceau QR (innerQrCodeHash null) → pas de gel', async () => {
    const id = await seedMission({ innerQrCodeHash: null })

    const count = await triggerAutoRefundWatchdog({ prisma })

    expect(count).toBe(0)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe(MissionStatus.IN_PROGRESS)
  })

  it('(F) déjà IN_DISPUTE → idempotent, aucune double transition', async () => {
    const id = await seedMission({
      status: MissionStatus.IN_DISPUTE,
      autoRefundDeadline: new Date(Date.now() - 1_000),
    })

    const count = await triggerAutoRefundWatchdog({ prisma })

    expect(count).toBe(0) // WHERE status=IN_PROGRESS filtre → aucune mise à jour
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe(MissionStatus.IN_DISPUTE) // inchangé
  })

  it('(G) horloge injectable — now avant deadline → exclusion correcte', async () => {
    const futureDeadline = new Date(Date.now() + 10_000)
    const id = await seedMission({ autoRefundDeadline: futureDeadline })

    // now < futureDeadline : éligible seulement si on passe now = futureDeadline + 1 ms.
    const countBefore = await triggerAutoRefundWatchdog({
      prisma,
      now: new Date(futureDeadline.getTime() - 1),
    })
    expect(countBefore).toBe(0)

    const countAfter = await triggerAutoRefundWatchdog({
      prisma,
      now: new Date(futureDeadline.getTime() + 1),
    })
    expect(countAfter).toBe(1)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
    expect(mission.status).toBe(MissionStatus.IN_DISPUTE)
  })
})
