import type { PrismaClient } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import { logger } from '../lib/logger'
import { recordWorkerLoop } from '../monitoring/workerTiming'
import { triggerAutoRefundWatchdog } from '../services/disputeResolution.service'

/**
 * Cycle de vie des « ghost missions » (audit robustesse).
 *
 * Une mission CREATED jamais financée est inerte : le financement réserve
 * CREATED → FUNDED AVANT tout paiement (cf. funding.route), donc rester CREATED
 * signifie qu'AUCUN escrow n'a été posé et qu'AUCUN argent n'est en jeu. Passé
 * `expiresAt`, c'est un fantôme : il pollue la vitrine et resterait finançable
 * (les routes /intent & /checkout-session ne contrôlent que `status === CREATED`).
 *
 * Ce worker clôt ces fantômes par LOTS BORNÉS (`batchSize`, défaut 50) : on
 * sélectionne au plus N ids éligibles puis on les bascule via un updateMany
 * conditionnel `CREATED → EXPIRED`, en boucle jusqu'à épuisement. Le plafond
 * `take` évite de charger en RAM un backlog illimité et de tenir un UPDATE géant
 * verrouillant des milliers de lignes d'un coup. Le filtre `status` reste
 * anti-TOCTOU : une mission financée entre lecture et écriture n'est plus CREATED
 * → jamais touchée. Aucun appel Stripe, aucune écriture comptable. Idempotent
 * (une mission déjà EXPIRED ne re-matche pas), relançable à volonté. `now` est figé
 * sur tout le balayage → snapshot cohérent entre les lots.
 */

/** Taille de lot par défaut : borne le `take` et la taille de chaque updateMany. */
export const DEFAULT_BATCH_SIZE = 50

export interface MissionLifecycleDeps {
  prisma: PrismaClient
  /** Horloge injectable (tests) — défaut : maintenant. */
  now?: Date
  /** Taille de lot (tests / tuning) — défaut DEFAULT_BATCH_SIZE. */
  batchSize?: number
}

/**
 * Clôt les missions CREATED expirées, par lots. Renvoie le nombre total clôturé
 * (observabilité). Boucle : findMany(take=batchSize) → updateMany(by id, conditionnel)
 * jusqu'à ce qu'un lot soit partiel (plus rien à clôturer).
 */
export async function expireGhostMissions(deps: MissionLifecycleDeps): Promise<number> {
  const now = deps.now ?? new Date()
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  let total = 0

  for (;;) {
    const batch = await deps.prisma.mission.findMany({
      where: { status: MissionStatus.CREATED, expiresAt: { lt: now } },
      select: { id: true },
      take: batchSize,
    })
    if (batch.length === 0) break

    const ids = batch.map(m => m.id)
    // updateMany re-filtré sur status+expiresAt : anti-TOCTOU (une mission financée
    // entre le SELECT et l'UPDATE n'est plus CREATED → exclue).
    const { count } = await deps.prisma.mission.updateMany({
      where: { id: { in: ids }, status: MissionStatus.CREATED, expiresAt: { lt: now } },
      data: { status: MissionStatus.EXPIRED },
    })
    total += count

    // Lot partiel = on a vu le fond de la file ; inutile de re-sonder.
    if (batch.length < batchSize) break
  }

  return total
}

/**
 * Boucle cron (~1 h par défaut) — miroir de `startRateLimitCleanupLoop`. Garde
 * `inFlight` (jamais deux passages concurrents dans CE process) + `.catch` (une
 * panne DB n'effondre pas le scheduler : le prochain tick reprend).
 */
export function startMissionLifecycleLoop(
  prisma: PrismaClient,
  intervalMs = 3_600_000, // 1 heure
  log: { error(details: Record<string, unknown>, message?: string): void } = logger,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return // passage précédent encore en cours — tick sauté
    inFlight = true
    // hrtime.bigint : durée du tick en nanosecondes, enregistrée pour /debug/performance.
    const start = process.hrtime.bigint()
    void expireGhostMissions({ prisma })
      .then(() => triggerAutoRefundWatchdog({ prisma }))
      .catch(err => log.error({ err: String(err) }, 'mission-lifecycle tick failed'))
      .finally(() => {
        recordWorkerLoop('mission-lifecycle', Number(process.hrtime.bigint() - start) / 1e6)
        inFlight = false
      })
  }, intervalMs)
}
