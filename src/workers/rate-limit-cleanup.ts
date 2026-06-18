import { prisma } from '../db'

/**
 * Purge des compteurs de rate-limit expirés (store Postgres, cf. rate-limit.ts).
 *
 * Le limiteur écrit une ligne par couple (clé, fenêtre) ; une fois `expiresAt`
 * dépassé, la ligne ne sert plus qu'à occuper de la place. Sans purge elle
 * s'accumule indéfiniment (chaque IP/email/route × chaque fenêtre). Ce DELETE,
 * indexé sur `expiresAt`, retire toutes les fenêtres closes. Renvoie le nombre
 * de lignes supprimées (diagnostic / observabilité).
 *
 * Sûr en concurrence multi-instance : deux purges simultanées ne font que se
 * partager les lignes à supprimer (un DELETE qui arrive second en supprime 0).
 */
export async function purgeExpiredRateLimits(): Promise<number> {
  return prisma.$executeRaw`DELETE FROM "RateLimit" WHERE "expiresAt" < NOW()`
}

/**
 * Boucle cron (~1 h par défaut) — miroir de `startBuyerCompensationWorkerLoop`.
 * Garde `inFlight` (jamais deux purges concurrentes dans CE process) + `.catch`
 * (une panne DB n'effondre pas le scheduler : on log, le prochain tick reprend).
 * Job sans état, idempotent, relançable à volonté.
 */
export function startRateLimitCleanupLoop(
  intervalMs = 3_600_000, // 1 heure
  log: { error(details: Record<string, unknown>, message?: string): void } = console,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return // purge précédente encore en cours — tick sauté
    inFlight = true
    void purgeExpiredRateLimits()
      .catch(err => log.error({ err: String(err) }, 'rate-limit cleanup tick failed'))
      .finally(() => {
        inFlight = false
      })
  }, intervalMs)
}
