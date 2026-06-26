import { Prisma } from '../generated/prisma'
import { prisma } from '../db'

export interface NotificationPayload {
  event: string
  missionId: string
  targetProduct: string
  destination: string
  amountCents?: number  // centimes Int — absent si non pertinent
}

export interface NotificationSink {
  send(recipientId: string, payload: NotificationPayload): Promise<void>
}

// Default sink: log structuré PII-safe (recipientId jamais logué en clair)
export const defaultSink: NotificationSink = {
  async send(_recipientId: string, payload: NotificationPayload): Promise<void> {
    console.log(JSON.stringify({
      level: 'info',
      kind: 'notification',
      event: payload.event,
      missionId: payload.missionId,
      // recipientId délibérément absent du log (routage uniquement, pas de PII)
    }))
  },
}

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

/**
 * Émet une notification idempotente vers un acteur.
 * Idempotence via ProcessedMissionEvent (@@unique [alias, missionId], namespace notif:*).
 * Appeler en fire-and-forget post-commit, JAMAIS dans un prisma.$transaction.
 */
export async function notifyActor(
  alias: string,
  missionId: string,
  recipientId: string,
  payload: NotificationPayload,
  sink: NotificationSink = defaultSink,
): Promise<void> {
  try {
    await prisma.processedMissionEvent.create({
      data: { alias, missionId },
    })
  } catch (err) {
    if (isUniqueViolation(err)) return  // déjà émis — no-op
    throw err
  }

  await sink.send(recipientId, payload)
}

// wire: notif:capture-confirmed — webhook payment_intent.succeeded → mission.travelerId
// wire: notif:delivery-validated — admin delivery-proof PATCH (VALIDATED) → mission.buyerId
// wire: notif:dispute-opened — DisputeService.openDispute → contrepartie
// wire: notif:dispute-resolved — DisputeResolutionWorker → mission.buyerId + mission.travelerId
