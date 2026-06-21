import type { PrismaClient } from '../generated/prisma'

/**
 * Keep-alive anti-pause Supabase (audit robustesse).
 *
 * Supabase (offre EU) MET EN PAUSE un projet sur inactivité **base de données**,
 * pas HTTP. Un self-ping de `/health` serait inutile : la route ne touche pas la
 * DB (`{ status: 'ok' }` pur). Ce worker exécute donc la sonde minimale qui compte :
 * un `SELECT 1` périodique, qui maintient une activité DB réelle et repousse la
 * fenêtre de pause.
 *
 * Read-only → naturellement IDEMPOTENT (aucune écriture, aucun état muté ;
 * relançable et concurrent-safe). Chaque sonde est journalisée (succès au niveau
 * info pour attester la vitalité ; échec capté par la boucle).
 */

export interface KeepAliveLogger {
  info(details: Record<string, unknown>, message?: string): void
  error(details: Record<string, unknown>, message?: string): void
}

export interface KeepAliveDeps {
  /** Surface minimale — accepte le client réel comme un fake de test. */
  prisma: Pick<PrismaClient, '$queryRaw'>
  log?: Pick<KeepAliveLogger, 'info'>
}

/** Sonde DB unique (`SELECT 1`). Lève si la DB est injoignable (captée par la boucle). */
export async function keepAlivePing(deps: KeepAliveDeps): Promise<void> {
  await deps.prisma.$queryRaw`SELECT 1`
  deps.log?.info({}, 'keep-alive : sonde DB OK (anti-pause Supabase)')
}

/**
 * Boucle cron (~20 min par défaut) — miroir de `startMissionLifecycleLoop`. Garde
 * `inFlight` (jamais deux sondes concurrentes dans CE process) + `.catch` (une DB
 * momentanément injoignable n'effondre pas le scheduler : le prochain tick reprend).
 */
export function startKeepAliveLoop(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  intervalMs = 20 * 60_000, // 20 minutes
  log: KeepAliveLogger = console,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return // sonde précédente encore en cours — tick sauté
    inFlight = true
    void keepAlivePing({ prisma, log })
      .catch(err => log.error({ err: String(err) }, 'keep-alive tick failed'))
      .finally(() => {
        inFlight = false
      })
  }, intervalMs)
}
