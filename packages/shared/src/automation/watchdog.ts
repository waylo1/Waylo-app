// Watchdog — retry avec backoff exponentiel + timeout strict.
//
// API publique :
//   automate(id, fn, opts?) → Promise<T>
//   WatchdogOptions, AttemptLog
//   WatchdogExhaustedError, WatchdogTimeoutError

/** Identifiant de timer cross-platform (Node.js NodeJS.Timeout | browser number). */
type TimerHandle = ReturnType<typeof setTimeout>

// ── Types publics ──────────────────────────────────────────────────────────────

export interface WatchdogOptions {
  /** Nombre de re-essais APRÈS la première tentative (total = maxRetries + 1). Défaut : 3. */
  readonly maxRetries?: number
  /** Délai initial avant le premier re-essai, en ms. Défaut : 200. */
  readonly backoffMs?: number
  /** Délai maximum par appel, en ms. Lève WatchdogTimeoutError si dépassé. Défaut : 30_000. */
  readonly timeoutMs?: number
  /** Multiplicateur exponentiel du backoff. Défaut : 2. */
  readonly exponentialFactor?: number
  /** Callback JSON-structuré après chaque tentative (succès ou échec). */
  readonly onLog?: (entry: AttemptLog) => void
}

export interface AttemptLog {
  readonly event: 'attempt_success' | 'attempt_failure' | 'exhausted'
  readonly id: string
  readonly attempt: number
  readonly maxRetries: number
  readonly durationMs: number
  readonly error?: string
}

// ── Erreurs ────────────────────────────────────────────────────────────────────

export class WatchdogTimeoutError extends Error {
  constructor(id: string, timeoutMs: number) {
    super(`[watchdog:${id}] timed out after ${timeoutMs}ms`)
    this.name = 'WatchdogTimeoutError'
  }
}

export class WatchdogExhaustedError extends Error {
  override readonly cause: unknown
  constructor(id: string, totalAttempts: number, cause: unknown) {
    super(`[watchdog:${id}] exhausted after ${totalAttempts} attempt(s)`)
    this.name = 'WatchdogExhaustedError'
    this.cause = cause
  }
}

// ── Utilitaires internes ───────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number, id: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle: TimerHandle = setTimeout(
      () => reject(new WatchdogTimeoutError(id, ms)),
      ms,
    )
    promise.then(
      v => { clearTimeout(handle); resolve(v) },
      e => { clearTimeout(handle); reject(e) },
    )
  })
}

// ── API publique ───────────────────────────────────────────────────────────────

/**
 * Exécute `fn` avec retry exponentiel + timeout strict.
 *
 * - Tente `maxRetries + 1` fois au total.
 * - Entre chaque essai : attend `backoffMs * factor^(attempt-1)` ms.
 * - Chaque tentative individuelle est bornée à `timeoutMs` ms.
 * - `onLog` reçoit un log structuré (JSON) après chaque tentative.
 * - Lève `WatchdogExhaustedError` si toutes les tentatives échouent,
 *   avec `cause` = dernière erreur pour diagnostic.
 */
export async function automate<T>(
  id: string,
  fn: () => Promise<T>,
  options: WatchdogOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    backoffMs = 200,
    timeoutMs = 30_000,
    exponentialFactor = 2,
    onLog,
  } = options

  const totalAttempts = maxRetries + 1
  let lastError: unknown

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const start = Date.now()
    try {
      const result = await raceWithTimeout(fn(), timeoutMs, id)
      onLog?.({
        event: 'attempt_success',
        id,
        attempt,
        maxRetries,
        durationMs: Date.now() - start,
      })
      return result
    } catch (err) {
      const durationMs = Date.now() - start
      const error = err instanceof Error ? err.message : String(err)
      lastError = err

      if (attempt < totalAttempts) {
        onLog?.({ event: 'attempt_failure', id, attempt, maxRetries, durationMs, error })
        const delay = backoffMs * Math.pow(exponentialFactor, attempt - 1)
        await sleep(delay)
      } else {
        onLog?.({ event: 'exhausted', id, attempt, maxRetries, durationMs, error })
      }
    }
  }

  throw new WatchdogExhaustedError(id, totalAttempts, lastError)
}
