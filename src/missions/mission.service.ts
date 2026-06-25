import { Prisma, MissionStatus } from '../generated/prisma'
import { prisma } from '../db'
import { runAlias, WatchdogExhaustedError } from '@waylo/shared/automation'

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
