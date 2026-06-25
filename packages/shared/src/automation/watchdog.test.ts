import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  automate,
  WatchdogExhaustedError,
  WatchdogTimeoutError,
} from './watchdog'
import type { AttemptLog } from './watchdog'

describe('automate — watchdog retry + timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retourne le résultat au premier essai (succès immédiat)', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await automate('test-ok', fn)
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('réessaie après échec et réussit au 2ème essai', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue('recovered')

    const promise = automate('test-retry', fn, { maxRetries: 3, backoffMs: 100 })
    await vi.runAllTimersAsync()

    await expect(promise).resolves.toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('lève WatchdogExhaustedError après maxRetries+1 tentatives', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'))
    const promise = automate('test-exhausted', fn, { maxRetries: 2, backoffMs: 10 })
    // Pré-attacher le handler AVANT runAllTimers pour éviter UnhandledRejection.
    const expectation = expect(promise).rejects.toBeInstanceOf(WatchdogExhaustedError)
    await vi.runAllTimersAsync()
    await expectation
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('WatchdogExhaustedError emballe la dernière erreur dans .cause', async () => {
    const original = new Error('root cause')
    const fn = vi.fn().mockRejectedValue(original)
    // maxRetries=0 → 1 seul essai, pas de sleep, pas de fake timer nécessaire.
    const err = await automate('test-cause', fn, { maxRetries: 0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WatchdogExhaustedError)
    expect((err as WatchdogExhaustedError).cause).toBe(original)
  })

  it('lève WatchdogExhaustedError avec cause=WatchdogTimeoutError si fn dépasse timeoutMs', async () => {
    const fn = vi.fn().mockImplementation(() => new Promise<never>(() => undefined))
    const promise = automate('test-timeout', fn, { maxRetries: 0, timeoutMs: 1_000 })
    // Pré-attacher avant d'avancer le temps.
    const caught = promise.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_001)
    const err = await caught
    expect(err).toBeInstanceOf(WatchdogExhaustedError)
    expect((err as WatchdogExhaustedError).cause).toBeInstanceOf(WatchdogTimeoutError)
  })

  it('onLog — événements structurés : failure puis success', async () => {
    const logs: AttemptLog[] = []
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('result')

    const promise = automate('test-logs', fn, {
      maxRetries: 2,
      backoffMs: 10,
      onLog: e => logs.push(e),
    })
    await vi.runAllTimersAsync()
    await promise

    expect(logs).toHaveLength(2)
    expect(logs[0]?.event).toBe('attempt_failure')
    expect(logs[0]?.attempt).toBe(1)
    expect(logs[0]?.error).toBe('boom')
    expect(logs[1]?.event).toBe('attempt_success')
    expect(logs[1]?.attempt).toBe(2)
  })

  it('onLog — événement exhausted avec attempt et maxRetries corrects', async () => {
    const logs: AttemptLog[] = []
    const fn = vi.fn().mockRejectedValue(new Error('fail'))
    const promise = automate('test-exhausted-log', fn, {
      maxRetries: 2,
      backoffMs: 1,
      onLog: e => logs.push(e),
    })
    const expectation = expect(promise).rejects.toBeInstanceOf(WatchdogExhaustedError)
    await vi.runAllTimersAsync()
    await expectation

    const exhausted = logs.find(l => l.event === 'exhausted')
    expect(exhausted?.attempt).toBe(3)
    expect(exhausted?.maxRetries).toBe(2)
  })

  it('respecte maxRetries=0 : 1 seul essai, pas de sleep', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('no retry'))
    const err = await automate('test-no-retry', fn, { maxRetries: 0 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WatchdogExhaustedError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('backoff exponentiel — délais croissants entre les tentatives (Date.now fake)', async () => {
    const callTimes: number[] = []
    const fn = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now())
      throw new Error('fail')
    })

    const promise = automate('test-backoff', fn, {
      maxRetries: 3,
      backoffMs: 100,
      exponentialFactor: 2,
    })
    const expectation = expect(promise).rejects.toBeInstanceOf(WatchdogExhaustedError)
    await vi.runAllTimersAsync()
    await expectation

    // 1 premier essai + 3 re-essais = 4 appels.
    expect(callTimes).toHaveLength(4)
    // Intervalles : 100, 200, 400ms (fake time avancé par les sleeps).
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(100)
    expect(callTimes[2]! - callTimes[1]!).toBeGreaterThanOrEqual(200)
    expect(callTimes[3]! - callTimes[2]!).toBeGreaterThanOrEqual(400)
  })
})
