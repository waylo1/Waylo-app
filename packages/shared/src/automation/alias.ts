// Alias — Registry centralisé de configurations Watchdog nommées + factory.
//
// Templates métier pré-configurés : stripe-capture, mission-sync, webhook-retry.
// Validation à la registration (échec rapide au boot si config invalide).
// Idempotence : la clé est transmise à `fn` ; la garantie d'unicité est
// à la charge de la couche business (Prisma conditional update, upsert).

import { automate, WatchdogExhaustedError } from './watchdog'
import type { WatchdogOptions, AttemptLog } from './watchdog'

// ── Types publics ──────────────────────────────────────────────────────────────

/** Configuration d'un alias (hérite des options Watchdog). */
export interface AliasConfig extends WatchdogOptions {
  readonly name: string
}

export interface AliasRunOptions {
  /** Clé d'idempotence pour les opérations financières / webhooks. */
  readonly idempotencyKey?: string
  /** Override de logger pour cet appel. */
  readonly onLog?: (entry: AttemptLog) => void
}

// ── Erreurs ────────────────────────────────────────────────────────────────────

export class AliasConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AliasConfigError'
  }
}

export class AliasNotFoundError extends Error {
  constructor(name: string) {
    super(`Alias "${name}" not found. Call registerAlias() first.`)
    this.name = 'AliasNotFoundError'
  }
}

// ── Registry ───────────────────────────────────────────────────────────────────

const registry = new Map<string, AliasConfig>()

function validateConfig(config: AliasConfig): void {
  if (!config.name || config.name.trim().length === 0) {
    throw new AliasConfigError('Alias name must be a non-empty string')
  }
  if (
    config.maxRetries !== undefined &&
    (!Number.isInteger(config.maxRetries) || config.maxRetries < 0)
  ) {
    throw new AliasConfigError(
      `maxRetries must be a non-negative integer, got ${config.maxRetries}`,
    )
  }
  if (config.backoffMs !== undefined && config.backoffMs <= 0) {
    throw new AliasConfigError(`backoffMs must be > 0, got ${config.backoffMs}`)
  }
  if (config.timeoutMs !== undefined && config.timeoutMs <= 0) {
    throw new AliasConfigError(`timeoutMs must be > 0, got ${config.timeoutMs}`)
  }
  if (config.exponentialFactor !== undefined && config.exponentialFactor < 1) {
    throw new AliasConfigError(
      `exponentialFactor must be >= 1, got ${config.exponentialFactor}`,
    )
  }
}

/** Enregistre un alias dans le registry. Lève AliasConfigError si config invalide. */
export function registerAlias(config: AliasConfig): void {
  validateConfig(config)
  registry.set(config.name, config)
}

/** Retourne la config d'un alias ou lève AliasNotFoundError. */
export function getAlias(name: string): AliasConfig {
  const config = registry.get(name)
  if (config === undefined) throw new AliasNotFoundError(name)
  return config
}

/** Liste les noms de tous les alias enregistrés. */
export function listAliases(): readonly string[] {
  return Array.from(registry.keys())
}

/** Vide le registry (utilitaire de test — ne pas appeler en production). */
export function clearRegistry(): void {
  registry.clear()
}

// ── Factory & runner ───────────────────────────────────────────────────────────

/**
 * Exécute un alias nommé sur `fn`.
 *
 * `fn` reçoit la clé d'idempotence (undefined si absente) pour qu'elle puisse
 * l'injecter dans l'appel Stripe ou la transaction Prisma. L'idempotence réelle
 * est garantie côté business (DB conditional update / Stripe idempotency-key) :
 * deux appels concurrents avec la même clé arrivent tous les deux à `fn` — c'est
 * `fn` qui décide du résultat (no-op ou action).
 */
export async function runAlias<T>(
  name: string,
  fn: (idempotencyKey: string | undefined) => Promise<T>,
  opts: AliasRunOptions = {},
): Promise<T> {
  // async : tout throw synchrone (getAlias) devient une rejection, jamais un crash.
  const config = getAlias(name)
  const { idempotencyKey, onLog } = opts
  const taskId = idempotencyKey !== undefined ? `${name}:${idempotencyKey}` : name
  try {
    return await automate(taskId, () => fn(idempotencyKey), {
      ...config,
      onLog: onLog ?? config.onLog,
    })
  } catch (err) {
    if (err instanceof WatchdogExhaustedError) {
      err.alias = name
    }
    throw err
  }
}

// ── Templates métier ───────────────────────────────────────────────────────────

/**
 * Enregistre les trois templates métier au boot de l'application.
 * Idempotent : ré-enregistre si le nom existe déjà.
 */
export function registerBuiltinAliases(): void {
  // Capture Stripe — délai court (webhook 30s Stripe), pas de re-essai agressif.
  registerAlias({
    name: 'stripe-capture',
    maxRetries: 3,
    backoffMs: 500,
    timeoutMs: 15_000,
    exponentialFactor: 2,
  })
  // Sync missions — tolérant (réseau mobile instable), backoff léger.
  registerAlias({
    name: 'mission-sync',
    maxRetries: 5,
    backoffMs: 200,
    timeoutMs: 30_000,
    exponentialFactor: 2,
  })
  // Webhook retry — backoff long (idempotent, supporte les re-livraisons).
  registerAlias({
    name: 'webhook-retry',
    maxRetries: 4,
    backoffMs: 1_000,
    timeoutMs: 20_000,
    exponentialFactor: 2,
  })
  // Résolution de litige — délai modéré, 3 re-essais max.
  registerAlias({
    name: 'dispute-resolve',
    maxRetries: 3,
    backoffMs: 300,
    timeoutMs: 20_000,
    exponentialFactor: 2,
  })
}
