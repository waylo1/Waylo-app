import type { FastifyInstance } from 'fastify'

/**
 * slowRequestLogger — middleware d'observabilité GLOBAL.
 *
 * Mesure chaque requête au `process.hrtime.bigint()` (précision nanoseconde,
 * monotone — insensible aux ajustements d'horloge) et logue (warn) celles qui
 * dépassent le seuil. Deux hooks racine :
 *   - onRequest : estampille le départ (le plus tôt possible dans le cycle) ;
 *   - onResponse : calcule la durée réelle perçue client et logue si > seuil.
 *
 * Coût négligeable sous le seuil (deux lectures hrtime + une soustraction) ;
 * aucun log pour les requêtes rapides → pas de bruit.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Estampille de départ (hrtime ns), posée par onRequest. */
    startHrTime?: bigint
  }
}

/** Au-delà de cette durée (ms), la requête est loguée comme lente. */
export const SLOW_REQUEST_THRESHOLD_MS = 100

export function registerSlowRequestLogger(
  app: FastifyInstance,
  thresholdMs: number = SLOW_REQUEST_THRESHOLD_MS,
): void {
  app.addHook('onRequest', async req => {
    req.startHrTime = process.hrtime.bigint()
  })

  app.addHook('onResponse', async req => {
    if (req.startHrTime === undefined) return
    const durationMs = Number(process.hrtime.bigint() - req.startHrTime) / 1e6
    if (durationMs <= thresholdMs) return
    req.log.warn(
      {
        kind: 'SLOW_REQUEST',
        time: new Date().toISOString(),
        method: req.method,
        url: req.url,
        durationMs: Math.round(durationMs * 1000) / 1000,
      },
      `slow request: ${req.method} ${req.url} (${durationMs.toFixed(1)}ms > ${thresholdMs}ms)`,
    )
  })
}
