import type { PrismaClient } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import { logger } from '../lib/logger'
import { notifyActor } from '../notifications/notification.service'

/**
 * DisputeService — Watchdog auto-refund (aucune intervention humaine).
 *
 * Distinct du cycle structuré `dispute.service.ts` (model `Dispute`, statut mission
 * `DISPUTED`, arbitrage admin DRAFT→OPEN→ESCALATED→RESOLVED→CLOSED) : ICI tout est
 * porté par le statut mission `IN_DISPUTE` + l'échéance `disputeDeadline`.
 *
 * Flux :
 *   1. `/ship` pose `autoRefundDeadline = now + 72 h` sur la mission.
 *   2. `triggerAutoRefundWatchdog` (tick horaire, mission-lifecycle) : détecte les
 *      missions IN_PROGRESS dont la deadline est dépassée et les gèle en IN_DISPUTE.
 *   3. `DisputeResolutionWorker` ENQUEUE : détecte les IN_DISPUTE à `disputeDeadline`
 *      dépassée et enfile un OutboxEvent READY_FOR_REFUND.
 *   4. `DisputeResolutionWorker` CONSUME : annule le hold Stripe (HORS tx) → REFUNDED.
 *
 * GARDES FAIRNESS (anti-fraude acheteur) :
 *   - `dropoffReceiptUrl IS NULL` : pas de preuve de dépôt voyageur.
 *   - `dropOffTrackingId IS NULL` : pas de suivi de dépôt logistique.
 *   Si l'une de ces preuves est présente, le watchdog ne gèle PAS — l'arbitrage humain
 *   (/dispute) reste le seul chemin de résolution.
 *
 * SÛRETÉ :
 *   - Anti-TOCTOU : `updateMany WHERE { id, status: IN_PROGRESS, ... }` — un scan
 *     concurrent ou une transition parallèle (/receive) n'est jamais double-traitée.
 *   - Idempotence : `WHERE status = IN_PROGRESS` exclut les missions déjà IN_DISPUTE.
 *   - Lot borné (batchSize, défaut 50) : pas de full scan illimité.
 */

/** Fenêtre de résolution automatique : 72 h après l'ouverture du litige. */
export const DISPUTE_WINDOW_MS = 72 * 60 * 60 * 1000

export interface WatchdogDeps {
  prisma: PrismaClient
  /** Horloge injectable (tests) — défaut : maintenant. */
  now?: Date
  /** Taille de lot (tests / tuning) — défaut 50. */
  batchSize?: number
}

/**
 * Gèle les missions IN_PROGRESS dont le délai de 72 h (autoRefundDeadline posé à
 * /ship) est dépassé, sans preuve de livraison voyageur. Transition atomique par
 * mission (anti-TOCTOU). Notification fire-and-forget vers le voyageur.
 * Renvoie le nombre de missions effectivement gelées.
 */
export async function triggerAutoRefundWatchdog(deps: WatchdogDeps): Promise<number> {
  const now = deps.now ?? new Date()
  const batchSize = deps.batchSize ?? 50

  // Sélection indexée (idx_auto_refund) : seules les missions IN_PROGRESS à deadline
  // dépassée, scellées QR, sans preuve de livraison voyageur.
  const eligible = await deps.prisma.mission.findMany({
    where: {
      status: MissionStatus.IN_PROGRESS,
      autoRefundDeadline: { lte: now },
      innerQrCodeHash: { not: null },
      dropoffReceiptUrl: null,
      dropOffTrackingId: null,
    },
    select: { id: true, travelerId: true, targetProduct: true, destination: true },
    take: batchSize,
  })

  if (eligible.length === 0) return 0

  let count = 0
  for (const { id, travelerId, targetProduct, destination } of eligible) {
    // Transition atomique par mission : anti-TOCTOU (une transition concurrente /receive
    // ou /drop-off qui poserait dropoffReceiptUrl/dropOffTrackingId entre le SELECT et
    // l'UPDATE serait détectée par les gardes du WHERE → count 0 → no-op).
    const updated = await deps.prisma.mission.updateMany({
      where: {
        id,
        status: MissionStatus.IN_PROGRESS,
        autoRefundDeadline: { lte: now },
        dropoffReceiptUrl: null,
        dropOffTrackingId: null,
      },
      data: {
        status: MissionStatus.IN_DISPUTE,
        disputeOpenedAt: now,
        // disputeDeadline = now : immédiatement éligible à la phase ENQUEUE du
        // DisputeResolutionWorker — le refund Stripe suit au prochain tick (~1 min).
        disputeDeadline: now,
      },
    })
    if (updated.count === 1) {
      count++
      if (travelerId) {
        notifyActor('notif:dispute-opened', id, travelerId, {
          event: 'notif:dispute-opened',
          missionId: id,
          targetProduct,
          destination,
        }).catch(err =>
          logger.error({ err, missionId: id }, '[notif] dispute-opened failed'),
        )
      }
    }
  }

  return count
}
