import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CleanupScheduler, CleanupWorkerError } from './cleanup'
import type { CleanupLog } from './cleanup'

describe("CleanupScheduler — janitor + escalade d'erreurs", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // ── Registration ────────────────────────────────────────────────────────────

  it('register + start : fn appelé après le premier interval', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    const scheduler = new CleanupScheduler()
    scheduler.register({ id: 'w1', intervalMs: 100, fn })
    scheduler.start('w1')

    await vi.advanceTimersByTimeAsync(150)
    expect(fn).toHaveBeenCalledTimes(1)

    scheduler.stopAll()
  })

  it('register deux fois le même id lève CleanupWorkerError', () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    const scheduler = new CleanupScheduler()
    scheduler.register({ id: 'dup', intervalMs: 100, fn })
    expect(() => scheduler.register({ id: 'dup', intervalMs: 200, fn })).toThrow(
      CleanupWorkerError,
    )
  })

  it('start sur id inconnu lève CleanupWorkerError', () => {
    const scheduler = new CleanupScheduler()
    expect(() => scheduler.start('ghost')).toThrow(CleanupWorkerError)
  })

  // ── startAll / stopAll ─────────────────────────────────────────────────────

  it('startAll démarre tous les workers', async () => {
    const fn1 = vi.fn().mockResolvedValue(undefined)
    const fn2 = vi.fn().mockResolvedValue(undefined)
    const scheduler = new CleanupScheduler()
    scheduler.register({ id: 'a', intervalMs: 100, fn: fn1 })
    scheduler.register({ id: 'b', intervalMs: 100, fn: fn2 })
    scheduler.startAll()

    await vi.advanceTimersByTimeAsync(150)
    expect(fn1).toHaveBeenCalledTimes(1)
    expect(fn2).toHaveBeenCalledTimes(1)

    scheduler.stopAll()
  })

  it('stopAll arrête tous les ticks', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    const scheduler = new CleanupScheduler()
    scheduler.register({ id: 'w', intervalMs: 100, fn })
    scheduler.startAll()
    scheduler.stopAll()

    await vi.advanceTimersByTimeAsync(500)
    expect(fn).toHaveBeenCalledTimes(0)
  })

  // ── inFlight guard ─────────────────────────────────────────────────────────

  it('inFlight : un second tick est ignoré si le premier est en cours', async () => {
    let resolve!: () => void
    const fn = vi.fn().mockImplementation(
      () => new Promise<void>(r => { resolve = r }),
    )
    const logs: CleanupLog[] = []
    const scheduler = new CleanupScheduler({ onLog: e => logs.push(e) })
    scheduler.register({ id: 'slow', intervalMs: 100, fn })
    scheduler.start('slow')

    // Premier tick commence (fn bloque).
    await vi.advanceTimersByTimeAsync(110)
    // Deuxième interval : tick ignoré (inFlight=true).
    await vi.advanceTimersByTimeAsync(100)

    // fn n'a été appelée qu'une fois.
    expect(fn).toHaveBeenCalledTimes(1)

    // On libère le premier tick.
    resolve()
    await vi.advanceTimersByTimeAsync(10)

    scheduler.stopAll()

    const starts = logs.filter(l => l.event === 'tick_start')
    expect(starts).toHaveLength(1)
  })

  // ── Escalade d'erreurs : suspension ────────────────────────────────────────

  it('suspend le worker après maxConsecutiveFailures échecs consécutifs', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('db down'))
    const logs: CleanupLog[] = []
    const scheduler = new CleanupScheduler({
      maxConsecutiveFailures: 3,
      onLog: e => logs.push(e),
    })
    scheduler.register({ id: 'flaky', intervalMs: 50, fn })
    scheduler.start('flaky')

    // 3 ticks échoués (3 × 50ms).
    await vi.advanceTimersByTimeAsync(200)

    expect(scheduler.isSuspended('flaky')).toBe(true)
    const suspended = logs.find(l => l.event === 'worker_suspended')
    expect(suspended?.consecutiveFailures).toBe(3)
  })

  it('plus aucun tick après suspension', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    const scheduler = new CleanupScheduler({ maxConsecutiveFailures: 2 })
    scheduler.register({ id: 'down', intervalMs: 50, fn })
    scheduler.start('down')

    // Atteindre la suspension.
    await vi.advanceTimersByTimeAsync(150)
    expect(scheduler.isSuspended('down')).toBe(true)

    const callsAtSuspension = fn.mock.calls.length
    // Avancer après suspension : plus de tick.
    await vi.advanceTimersByTimeAsync(500)
    expect(fn).toHaveBeenCalledTimes(callsAtSuspension)
  })

  it('resume remet le worker en marche après suspension', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    const logs: CleanupLog[] = []
    const scheduler = new CleanupScheduler({
      maxConsecutiveFailures: 2,
      onLog: e => logs.push(e),
    })
    scheduler.register({ id: 'recoverable', intervalMs: 50, fn })
    scheduler.start('recoverable')

    // Déclencher la suspension.
    await vi.advanceTimersByTimeAsync(150)
    expect(scheduler.isSuspended('recoverable')).toBe(true)

    // fn réussit désormais.
    fn.mockResolvedValue(undefined)
    scheduler.resume('recoverable')
    expect(scheduler.isSuspended('recoverable')).toBe(false)

    const resumed = logs.find(l => l.event === 'worker_resumed')
    expect(resumed).toBeDefined()

    await vi.advanceTimersByTimeAsync(100)
    scheduler.stopAll()
  })

  it('resume est sans effet sur un worker non suspendu', () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    const scheduler = new CleanupScheduler()
    scheduler.register({ id: 'ok', intervalMs: 100, fn })
    expect(() => scheduler.resume('ok')).not.toThrow()
  })

  it('un succès remet à zéro le compteur consecutiveFailures', async () => {
    let call = 0
    const fn = vi.fn().mockImplementation(async () => {
      call++
      // Échoue les 2 premiers, réussit au 3ème.
      if (call < 3) throw new Error('transient')
    })
    const scheduler = new CleanupScheduler({ maxConsecutiveFailures: 5 })
    scheduler.register({ id: 'transient', intervalMs: 50, fn })
    scheduler.start('transient')

    // 3 ticks : 2 échecs + 1 succès.
    await vi.advanceTimersByTimeAsync(200)
    expect(scheduler.isSuspended('transient')).toBe(false)

    scheduler.stopAll()
  })

  // ── Timeout de tick ─────────────────────────────────────────────────────────

  it('tick_timeout si fn dépasse maxDurationMs', async () => {
    const fn = vi.fn().mockImplementation(() => new Promise<void>(() => undefined))
    const logs: CleanupLog[] = []
    const scheduler = new CleanupScheduler({ onLog: e => logs.push(e) })
    scheduler.register({ id: 'timeout-w', intervalMs: 100, fn, maxDurationMs: 200 })
    scheduler.start('timeout-w')

    await vi.advanceTimersByTimeAsync(400)

    const timeouts = logs.filter(l => l.event === 'tick_timeout')
    expect(timeouts.length).toBeGreaterThan(0)

    scheduler.stopAll()
  })

  // ── onLog structuré ─────────────────────────────────────────────────────────

  it('onLog émet tick_start → tick_success sur succès', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    const logs: CleanupLog[] = []
    const scheduler = new CleanupScheduler({ onLog: e => logs.push(e) })
    scheduler.register({ id: 'log-w', intervalMs: 50, fn })
    scheduler.start('log-w')

    await vi.advanceTimersByTimeAsync(80)
    scheduler.stopAll()

    expect(logs.some(l => l.event === 'tick_start' && l.workerId === 'log-w')).toBe(true)
    expect(logs.some(l => l.event === 'tick_success' && l.workerId === 'log-w')).toBe(true)
  })
})
