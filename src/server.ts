import Stripe from 'stripe'
import { startTransferWorkerLoop } from './workers/transfer-worker'
import { runReconciliation } from './workers/reconciliation'
import type { ReconciliationDeps } from './workers/reconciliation'

/**
 * Point d'entrée serveur Waylo — MVP monoprocess : trois composants démarrés
 * côte à côte, chacun derrière sa propre fonction avec handle d'arrêt :
 *   1. HTTP Fastify (webhooks Stripe + /health) ;
 *   2. worker de transfert outbox (tick ~1 min) ;
 *   3. réconciliation quotidienne (sans chevauchement).
 * Les séparer plus tard = déplacer l'appel de démarrage correspondant dans son
 * propre process — aucun couplage entre eux hors prisma/stripe partagés.
 *
 * `./db` et `./app` sont importés APRÈS la validation des variables
 * d'environnement : PrismaClient et les secrets Stripe sont lus à
 * l'instanciation — on garantit d'abord un message d'erreur clair.
 */

export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_ISSUING_WEBHOOK_SECRET',
] as const

/** Contrôle de présence (non vide) uniquement — aucun appel réseau. */
export function missingRequiredEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return REQUIRED_ENV_VARS.filter(name => !env[name])
}

const DEFAULT_PORT = 3000
const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_WORKER_INTERVAL_MS = 60_000
const DEFAULT_RECONCILIATION_INTERVAL_MS = 24 * 3600 * 1000

interface OpsLogger {
  info(details: Record<string, unknown>, message?: string): void
  error(details: Record<string, unknown>, message?: string): void
}

/**
 * Cron de réconciliation : `setInterval` + garde `inFlight`. Un tick qui
 * arrive pendant un run en cours est SAUTÉ — jamais deux runs concurrents —
 * et `stop()` attend la fin du run en vol avant de rendre la main.
 */
export function startReconciliationCron(
  deps: ReconciliationDeps,
  intervalMs: number,
  log: OpsLogger,
): { stop(): Promise<void> } {
  let inFlight: Promise<void> | null = null
  const timer = setInterval(() => {
    if (inFlight) {
      log.info({}, 'réconciliation : run précédent encore en cours, tick sauté')
      return
    }
    inFlight = runReconciliation(deps)
      .then(alerts => log.info({ alerts: alerts.length }, 'réconciliation terminée'))
      .catch((err: unknown) => log.error({ err: String(err) }, 'réconciliation échouée'))
      .finally(() => {
        inFlight = null
      })
  }, intervalMs)
  return {
    async stop(): Promise<void> {
      clearInterval(timer)
      if (inFlight) await inFlight
    },
  }
}

/** Entier strictement positif depuis l'env, avec défaut — erreur nommée sinon. */
function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} invalide : « ${raw} » (entier strictement positif attendu)`)
  }
  return value
}

async function main(): Promise<void> {
  const missing = missingRequiredEnv()
  if (missing.length > 0) {
    console.error(
      `Variables d'environnement requises manquantes : ${missing.join(', ')} — démarrage refusé.`,
    )
    process.exit(1)
  }

  const port = intFromEnv('PORT', DEFAULT_PORT)
  const host = process.env.HOST ?? DEFAULT_HOST
  const workerIntervalMs = intFromEnv('WORKER_INTERVAL_MS', DEFAULT_WORKER_INTERVAL_MS)
  const reconciliationIntervalMs = intFromEnv(
    'RECONCILIATION_INTERVAL_MS',
    DEFAULT_RECONCILIATION_INTERVAL_MS,
  )

  const { prisma } = await import('./db')
  const { buildApp } = await import('./app')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string)

  const app = await buildApp()
  const log: OpsLogger = {
    info: (details, message) => app.log.info(details, message),
    error: (details, message) => app.log.error(details, message),
  }

  await app.listen({ port, host })

  const workerTimer = startTransferWorkerLoop({ prisma, stripe, log }, workerIntervalMs)
  const reconciliation = startReconciliationCron(
    { prisma, stripe },
    reconciliationIntervalMs,
    log,
  )
  log.info(
    { port, host, workerIntervalMs, reconciliationIntervalMs },
    'Waylo démarré — HTTP + worker outbox + cron réconciliation',
  )

  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log.info({ signal }, 'arrêt gracieux demandé')
    // Plus de nouveaux ticks. Un transfert en vol n'est pas coupé par nous ;
    // si le process meurt en plein appel Stripe, la ligne SUBMITTED rassise
    // est reprise par un prochain tick et l'idempotencyKey rend le rejeu sûr.
    clearInterval(workerTimer)
    await reconciliation.stop()
    await app.close() // cesse d'accepter, draine les requêtes en vol
    await prisma.$disconnect()
    log.info({}, 'arrêt gracieux terminé')
    process.exit(0)
  }
  process.once('SIGTERM', signal => void shutdown(signal))
  process.once('SIGINT', signal => void shutdown(signal))
}

// Démarre uniquement en exécution directe — l'import (tests) est sans effet.
if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
