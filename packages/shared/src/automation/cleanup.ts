// Cleanup — Janitor générique avec scheduler centralisé + escalade d'erreurs.
//
// Interface CleanupWorker { id, intervalMs, fn, maxDurationMs? }
// Escalade : log → skip (inFlight) → suspend si > maxConsecutiveFailures échecs.
// Chaque scheduler est indépendant — un par process ou par domaine fonctionnel.

type IntervalHandle = ReturnType<typeof setInterval>
type TimeoutHandle = ReturnType<typeof setTimeout>

// ── Types publics ──────────────────────────────────────────────────────────────

/** Déclaration d'un worker de nettoyage (immuable après registration). */
export interface CleanupWorker {
  readonly id: string
  readonly intervalMs: number
  readonly fn: () => Promise<void>
  /** Durée maximum par tick, en ms. Lève CleanupTimeoutError si dépassé. Défaut : 30_000. */
  readonly maxDurationMs?: number
}

export interface CleanupLog {
  readonly event:
    | 'tick_start'
    | 'tick_success'
    | 'tick_failure'
    | 'tick_timeout'
    | 'worker_suspended'
    | 'worker_resumed'
  readonly workerId: string
  readonly durationMs?: number
  readonly error?: string
  readonly consecutiveFailures?: number
}

export interface CleanupSchedulerOptions {
  /** Échecs consécutifs avant suspension automatique. Défaut : 5. */
  readonly maxConsecutiveFailures?: number
  /** Callback JSON-structuré pour tous les événements du janitor. */
  readonly onLog?: (entry: CleanupLog) => void
}

// ── Erreurs ────────────────────────────────────────────────────────────────────

export class CleanupWorkerError extends Error {
  constructor(workerId: string, message: string) {
    super(`[cleanup:${workerId}] ${message}`)
    this.name = 'CleanupWorkerError'
  }
}

class CleanupTimeoutError extends Error {
  constructor(workerId: string, ms: number) {
    super(`[cleanup:${workerId}] tick timed out after ${ms}ms`)
    this.name = 'CleanupTimeoutError'
  }
}

// ── État interne (mutable — intentionnel) ──────────────────────────────────────

interface WorkerState {
  readonly worker: CleanupWorker
  timer: IntervalHandle | null
  consecutiveFailures: number
  suspended: boolean
  inFlight: boolean
}

// ── Utilitaire interne ─────────────────────────────────────────────────────────

function raceWithTimeout(promise: Promise<void>, ms: number, workerId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle: TimeoutHandle = setTimeout(
      () => reject(new CleanupTimeoutError(workerId, ms)),
      ms,
    )
    promise.then(
      () => { clearTimeout(handle); resolve() },
      e => { clearTimeout(handle); reject(e) },
    )
  })
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export class CleanupScheduler {
  private readonly workers = new Map<string, WorkerState>()
  private readonly maxConsecutiveFailures: number
  private readonly onLog: (entry: CleanupLog) => void

  constructor(options: CleanupSchedulerOptions = {}) {
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5
    this.onLog = options.onLog ?? (() => undefined)
  }

  /** Enregistre un worker. Lève CleanupWorkerError si le même id est déjà enregistré. */
  register(worker: CleanupWorker): void {
    if (this.workers.has(worker.id)) {
      throw new CleanupWorkerError(worker.id, 'already registered')
    }
    this.workers.set(worker.id, {
      worker,
      timer: null,
      consecutiveFailures: 0,
      suspended: false,
      inFlight: false,
    })
  }

  /** Démarre le tick périodique d'un worker. Sans effet si déjà démarré. */
  start(id: string): void {
    const state = this.requireState(id)
    if (state.timer !== null || state.suspended) return

    state.timer = setInterval(() => { void this.tick(id) }, state.worker.intervalMs)
  }

  /** Démarre tous les workers enregistrés et non suspendus. */
  startAll(): void {
    for (const id of this.workers.keys()) this.start(id)
  }

  /** Arrête le timer d'un worker (sans modifier les compteurs d'erreurs). */
  stop(id: string): void {
    const state = this.requireState(id)
    if (state.timer !== null) {
      clearInterval(state.timer)
      state.timer = null
    }
  }

  /** Arrête tous les workers. */
  stopAll(): void {
    for (const id of this.workers.keys()) this.stop(id)
  }

  /** Reprend un worker suspendu en remettant à zéro les compteurs d'erreurs. */
  resume(id: string): void {
    const state = this.requireState(id)
    if (!state.suspended) return
    state.suspended = false
    state.consecutiveFailures = 0
    this.onLog({ event: 'worker_resumed', workerId: id })
    this.start(id)
  }

  /** Retourne true si le worker est suspendu suite à des échecs consécutifs. */
  isSuspended(id: string): boolean {
    return this.requireState(id).suspended
  }

  // ── Exécution d'un tick ─────────────────────────────────────────────────────

  private async tick(id: string): Promise<void> {
    const state = this.requireState(id)

    // inFlight : tick précédent encore en cours (DB lente, réseau) — sauté.
    // suspended : ne devrait pas arriver (timer stoppé), guard défensif.
    if (state.inFlight || state.suspended) return

    state.inFlight = true
    const maxDurationMs = state.worker.maxDurationMs ?? 30_000
    const start = Date.now()
    this.onLog({ event: 'tick_start', workerId: id })

    try {
      await raceWithTimeout(state.worker.fn(), maxDurationMs, id)
      state.consecutiveFailures = 0
      this.onLog({ event: 'tick_success', workerId: id, durationMs: Date.now() - start })
    } catch (err) {
      const durationMs = Date.now() - start
      const error = err instanceof Error ? err.message : String(err)
      state.consecutiveFailures++
      const event = err instanceof CleanupTimeoutError ? 'tick_timeout' : 'tick_failure'
      this.onLog({
        event,
        workerId: id,
        durationMs,
        error,
        consecutiveFailures: state.consecutiveFailures,
      })
      if (state.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.suspend(id)
      }
    } finally {
      state.inFlight = false
    }
  }

  private suspend(id: string): void {
    const state = this.requireState(id)
    state.suspended = true
    this.stop(id)
    this.onLog({
      event: 'worker_suspended',
      workerId: id,
      consecutiveFailures: state.consecutiveFailures,
    })
  }

  private requireState(id: string): WorkerState {
    const state = this.workers.get(id)
    if (state === undefined) throw new CleanupWorkerError(id, 'not registered')
    return state
  }
}
