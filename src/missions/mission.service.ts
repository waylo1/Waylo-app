import { Prisma, MissionStatus } from '../generated/prisma'
import { prisma } from '../db'
import { runAlias, WatchdogExhaustedError } from '@waylo/shared/automation'

export interface PublicMissionDTO {
  id: string
  status: MissionStatus
  targetProduct: string
  budgetCents: number
  commissionCents: number
  origin: string
  destination: string
  travelerId: string
  trackingReference: string | null
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

type MissionRow = {
  id: string
  status: MissionStatus
  targetProduct: string
  budgetCents: number
  commissionCents: number
  origin: string
  destination: string
  travelerId: string | null
  trackingReference: string | null
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

function toPublicMissionDTO(m: MissionRow): PublicMissionDTO {
  if (!m.travelerId) throw new Error(`INVARIANT: travelerId null on traveler-scoped mission ${m.id}`)
  return {
    id: m.id,
    status: m.status,
    targetProduct: m.targetProduct,
    budgetCents: m.budgetCents,
    commissionCents: m.commissionCents,
    origin: m.origin,
    destination: m.destination,
    travelerId: m.travelerId,
    trackingReference: m.trackingReference,
    expiresAt: m.expiresAt,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }
}

// Dashboard voyageur : statuts RÉELS du cycle de vie vivant (matchmaking /match·/accept),
// remplace l'ancien couple mort [ACTIVE, COMPLETED_BY_BUYER] (flux /assign + confirmReception
// supprimés, cf. DEADFLOWS). « En cours » (MATCHED → VALIDATED) + « terminé » (RELEASED).
const TRAVELER_DASHBOARD_STATUSES: MissionStatus[] = [
  MissionStatus.MATCHED,
  MissionStatus.IN_PROGRESS,
  MissionStatus.ESCROW_LOCKED_CUSTOMS,
  MissionStatus.PENDING_CUSTOMS_REVIEW,
  MissionStatus.AWAITING_VALIDATION,
  MissionStatus.DEPOSITED,
  MissionStatus.VALIDATED,
  MissionStatus.RELEASED,
]

export async function findMissionsForTraveler(travelerId: string): Promise<PublicMissionDTO[]> {
  const missions = await prisma.mission.findMany({
    where: {
      travelerId,
      status: { in: TRAVELER_DASHBOARD_STATUSES },
    },
    select: {
      id: true,
      status: true,
      targetProduct: true,
      budgetCents: true,
      commissionCents: true,
      origin: true,
      destination: true,
      travelerId: true,
      trackingReference: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return missions.map(toPublicMissionDTO)
}

export type NotifyFn = (missionId: string) => Promise<void>

export async function notifyMatchingTravelers(missionId: string): Promise<void> {
  console.log(`[mission-created] notifying travelers for mission ${missionId}`)
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

/**
 * Déclenche la notification des voyageurs correspondants APRÈS commit de la mission.
 * Idempotent via ProcessedMissionEvent (source de vérité permanente — runAlias.idempotencyKey
 * est un label de traçage, pas une dédup). Appeler en fire-and-forget depuis la route POST.
 */
export async function triggerMissionCreatedNotification(
  missionId: string,
  notify: NotifyFn = notifyMatchingTravelers,
): Promise<void> {
  // Idempotence permanente : un seul passage par (alias, missionId). Second appel → no-op.
  try {
    await prisma.processedMissionEvent.create({
      data: { alias: 'mission-created', missionId },
    })
  } catch (err) {
    if (isUniqueViolation(err)) return
    throw err
  }

  try {
    await runAlias('mission-created', (_key) => notify(missionId), {
      idempotencyKey: missionId,
    })
  } catch (err) {
    if (err instanceof WatchdogExhaustedError) {
      console.error({ err, missionId }, '[mission-created] watchdog exhausted — marking NOTIFICATION_FAILED')
      await prisma.mission.updateMany({
        where: { id: missionId, status: MissionStatus.CREATED },
        data: { status: MissionStatus.NOTIFICATION_FAILED },
      })
    } else {
      throw err
    }
  }
}
