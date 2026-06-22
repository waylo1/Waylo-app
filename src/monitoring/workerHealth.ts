import type { PrismaClient } from '../generated/prisma'

/**
 * workerHealth — observabilité LECTURE SEULE de la file OutboxEvent (S22).
 *
 * `getWorkerMetrics` compte les événements par statut (PENDING / FAILED) et
 * détecte le backlog bloqué (PENDING plus vieux que le seuil). Conçu pour un
 * impact NUL sur le chemin du worker : uniquement des `count()` sur la colonne
 * indexée `status` (@@index([status])), exécutés dans un cron séparé — jamais
 * dans la boucle de capture.
 *
 * Aucune écriture, aucun appel réseau : sûr à appeler à n'importe quelle cadence.
 */

/** Logger structuré minimal (compatible pino/Fastify). */
export interface WorkerHealthLogger {
  info(details: Record<string, unknown>, message?: string): void
  warn(details: Record<string, unknown>, message?: string): void
}

export interface WorkerMetrics {
  /** Événements en attente de traitement par le worker de payout. */
  pending: number
  /** Événements en échec terminal — nécessitent une intervention manuelle. */
  failed: number
  /** PENDING plus vieux que STALE_PENDING_MS : backlog bloqué (worker en retard / à l'arrêt). */
  stalePending: number
  /** Horodatage de collecte (ISO). */
  collectedAt: string
}

/** Un PENDING au-delà de ce seuil signale un backlog anormal. */
export const STALE_PENDING_MS = 10 * 60_000
const STALE_PENDING_MINUTES = STALE_PENDING_MS / 60_000

/**
 * Collecte les métriques de santé de la file OutboxEvent (lecture seule).
 * Si un logger est fourni : un `info` systématique (état global) + un `warn` par
 * anomalie (FAILED > 0, PENDING bloqués). `now` est injectable pour les tests.
 */
export async function getWorkerMetrics(
  prisma: PrismaClient,
  log?: WorkerHealthLogger,
  now: Date = new Date(),
): Promise<WorkerMetrics> {
  const staleBefore = new Date(now.getTime() - STALE_PENDING_MS)

  // Trois COUNT indexés sur `status`, en parallèle — aucune écriture, aucun scan lourd.
  const [pending, failed, stalePending] = await Promise.all([
    prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
    prisma.outboxEvent.count({ where: { status: 'FAILED' } }),
    prisma.outboxEvent.count({ where: { status: 'PENDING', createdAt: { lt: staleBefore } } }),
  ])

  const metrics: WorkerMetrics = {
    pending,
    failed,
    stalePending,
    collectedAt: now.toISOString(),
  }

  if (log) {
    log.info({ kind: 'WORKER_HEALTH', ...metrics }, 'worker health: métriques OutboxEvent')
    if (failed > 0) {
      log.warn(
        { kind: 'WORKER_HEALTH', failed },
        `worker health: ${failed} OutboxEvent en échec (FAILED) — intervention manuelle requise`,
      )
    }
    if (stalePending > 0) {
      log.warn(
        { kind: 'WORKER_HEALTH', stalePending, thresholdMinutes: STALE_PENDING_MINUTES },
        `worker health: ${stalePending} OutboxEvent PENDING depuis plus de ${STALE_PENDING_MINUTES} minutes`,
      )
    }
  }

  return metrics
}

/**
 * Cron de santé worker — log périodique de l'état global du système (lecture
 * seule). Cadence par défaut 5 min : un health-check n'a pas besoin de la cadence
 * du worker. Une collecte en échec est loguée en warn, jamais propagée (le cron
 * ne doit pas tomber). Retourne le timer pour un `clearInterval` propre au shutdown.
 */
export function startWorkerHealthLoop(
  prisma: PrismaClient,
  log: WorkerHealthLogger,
  intervalMs = 5 * 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    void getWorkerMetrics(prisma, log).catch((err: unknown) =>
      log.warn({ kind: 'WORKER_HEALTH', err: String(err) }, 'worker health: collecte échouée'),
    )
  }, intervalMs)
}
