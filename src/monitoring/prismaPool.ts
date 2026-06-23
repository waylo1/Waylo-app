import type { PrismaClient } from '../generated/prisma'

/**
 * prismaPool — lecture des jauges du pool de connexions exposées par
 * `prisma.$metrics.json()` (preview feature `metrics`, cf. schema.prisma).
 *
 * Défensif par conception : si `$metrics` est indisponible (feature désactivée,
 * client étendu sans la méthode) ou si la collecte échoue, on renvoie `null`
 * plutôt que de faire échouer l'endpoint de diagnostic.
 */

export interface PrismaPoolStats {
  /** Connexions ouvertes (busy + idle). */
  open: number
  /** Connexions en cours d'utilisation par une requête. */
  busy: number
  /** Connexions ouvertes mais au repos. */
  idle: number
}

interface MetricsGauge {
  key: string
  value: number
}
interface MetricsJson {
  gauges: MetricsGauge[]
}
interface MetricsCapable {
  $metrics?: { json(): Promise<MetricsJson> }
}

/** Snapshot du pool de connexions Prisma, ou `null` si les métriques sont indisponibles. */
export async function readPrismaPoolStats(prisma: PrismaClient): Promise<PrismaPoolStats | null> {
  const metrics = (prisma as unknown as MetricsCapable).$metrics
  if (typeof metrics?.json !== 'function') return null
  try {
    const json = await metrics.json()
    const pick = (key: string): number => json.gauges.find(g => g.key === key)?.value ?? 0
    return {
      open: pick('prisma_pool_connections_open'),
      busy: pick('prisma_pool_connections_busy'),
      idle: pick('prisma_pool_connections_idle'),
    }
  } catch {
    return null
  }
}
