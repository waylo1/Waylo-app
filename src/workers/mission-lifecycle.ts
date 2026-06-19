import type { PrismaClient } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'

/**
 * Cycle de vie des « ghost missions » (audit robustesse).
 *
 * Une mission CREATED jamais financée est inerte : le financement réserve
 * CREATED → FUNDED AVANT tout paiement (cf. funding.route), donc rester CREATED
 * signifie qu'AUCUN escrow n'a été posé et qu'AUCUN argent n'est en jeu. Passé
 * `expiresAt`, c'est un fantôme : il pollue la vitrine et resterait finançable
 * (les routes /intent & /checkout-session ne contrôlent que `status === CREATED`).
 *
 * Ce worker clôt ces fantômes : transition conditionnelle CREATED → EXPIRED via
 * `updateMany({ where: { status: CREATED, expiresAt < now } })`. Le filtre `status`
 * est anti-TOCTOU : une mission financée entre lecture et écriture n'est plus
 * CREATED → jamais touchée. Aucun appel Stripe, aucune écriture comptable.
 * Idempotent (une mission déjà EXPIRED ne re-matche pas), relançable à volonté.
 */

export interface MissionLifecycleDeps {
  prisma: PrismaClient
  /** Horloge injectable (tests) — défaut : maintenant. */
  now?: Date
}

/** Clôt les missions CREATED expirées. Renvoie le nombre clôturé (observabilité). */
export async function expireGhostMissions(deps: MissionLifecycleDeps): Promise<number> {
  const now = deps.now ?? new Date()
  const { count } = await deps.prisma.mission.updateMany({
    where: { status: MissionStatus.CREATED, expiresAt: { lt: now } },
    data: { status: MissionStatus.EXPIRED },
  })
  return count
}

/**
 * Boucle cron (~1 h par défaut) — miroir de `startRateLimitCleanupLoop`. Garde
 * `inFlight` (jamais deux passages concurrents dans CE process) + `.catch` (une
 * panne DB n'effondre pas le scheduler : le prochain tick reprend).
 */
export function startMissionLifecycleLoop(
  prisma: PrismaClient,
  intervalMs = 3_600_000, // 1 heure
  log: { error(details: Record<string, unknown>, message?: string): void } = console,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return // passage précédent encore en cours — tick sauté
    inFlight = true
    void expireGhostMissions({ prisma })
      .catch(err => log.error({ err: String(err) }, 'mission-lifecycle tick failed'))
      .finally(() => {
        inFlight = false
      })
  }, intervalMs)
}
