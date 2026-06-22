import { prisma } from '../db'
import { MissionStatus } from '../generated/prisma'
import type { Mission } from '../generated/prisma'

/**
 * DisputeService — litige AUTOMATISÉ (aucune intervention humaine).
 *
 * Distinct du cycle structuré `dispute.service.ts` (model `Dispute`, statut mission
 * `DISPUTED`, arbitrage admin DRAFT→OPEN→ESCALATED→RESOLVED→CLOSED) : ICI tout est
 * porté par le statut mission `IN_DISPUTE` + l'échéance `disputeDeadline` (now + 72 h).
 *
 *   openDispute(missionId, reason) — gèle la mission (IN_DISPUTE) et arme la deadline.
 *     • le payout voyageur est bloqué tant que IN_DISPUTE (garde escrowPayoutWorker) ;
 *     • à `disputeDeadline` dépassée, DisputeResolutionWorker déclenche un REFUND
 *       Stripe via l'outbox (OutboxEvent READY_FOR_REFUND) → mission REFUNDED.
 *
 * SÛRETÉ :
 * - Anti-TOCTOU : transition conditionnelle atomique (`updateMany` filtré sur le
 *   statut source) dans une `prisma.$transaction` — `count !== 1` ⇒ état incompatible.
 * - Idempotence : un appel sur une mission déjà IN_DISPUTE est un no-op (la deadline
 *   N'EST PAS réarmée — le délai de 72 h court depuis la PREMIÈRE ouverture).
 * - États non litigeables : missions soldées (RELEASED/REFUNDED/CANCELLED/EXPIRED) ou
 *   déjà sous arbitrage humain (DISPUTED/DISPUTED_FRAUD) → MISSION_NOT_DISPUTABLE.
 */

/** Fenêtre de résolution automatique : 72 h après l'ouverture du litige. */
export const DISPUTE_WINDOW_MS = 72 * 60 * 60 * 1000

/**
 * États depuis lesquels un litige automatisé est REFUSÉ : missions soldées (aucun
 * hold à rembourser) ou déjà prises en charge par l'arbitrage humain (model Dispute).
 */
const NON_DISPUTABLE: readonly MissionStatus[] = [
  MissionStatus.RELEASED,
  MissionStatus.REFUNDED,
  MissionStatus.CANCELLED,
  MissionStatus.EXPIRED,
  MissionStatus.DISPUTED,
  MissionStatus.DISPUTED_FRAUD,
]

export class DisputeResolutionError extends Error {
  constructor(readonly code: 'MISSION_NOT_FOUND' | 'MISSION_NOT_DISPUTABLE') {
    super(code)
    this.name = 'DisputeResolutionError'
  }
}

/**
 * Ouvre un litige automatisé : mission → IN_DISPUTE, `disputeOpenedAt` = now,
 * `disputeDeadline` = now + 72 h, `disputeReason` = reason. Idempotent.
 */
export async function openDispute(missionId: string, reason?: string | null): Promise<Mission> {
  const now = new Date()
  const deadline = new Date(now.getTime() + DISPUTE_WINDOW_MS)

  return prisma.$transaction(async tx => {
    const mission = await tx.mission.findUnique({
      where: { id: missionId },
      select: { status: true },
    })
    if (!mission) throw new DisputeResolutionError('MISSION_NOT_FOUND')

    // Idempotence : déjà en litige → no-op, la deadline N'EST PAS réarmée.
    if (mission.status === MissionStatus.IN_DISPUTE) {
      return tx.mission.findUniqueOrThrow({ where: { id: missionId } })
    }
    if (NON_DISPUTABLE.includes(mission.status)) {
      throw new DisputeResolutionError('MISSION_NOT_DISPUTABLE')
    }

    // Transition conditionnelle anti-TOCTOU : le filtre sur le statut source garantit
    // qu'une transition concurrente (autre worker/route) ne se superpose pas.
    const updated = await tx.mission.updateMany({
      where: { id: missionId, status: mission.status },
      data: {
        status: MissionStatus.IN_DISPUTE,
        disputeOpenedAt: now,
        disputeDeadline: deadline,
        disputeReason: reason ?? null,
      },
    })
    if (updated.count !== 1) throw new DisputeResolutionError('MISSION_NOT_DISPUTABLE')

    return tx.mission.findUniqueOrThrow({ where: { id: missionId } })
  })
}
