import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AliasConfigError,
  AliasNotFoundError,
  clearRegistry,
  getAlias,
  listAliases,
  registerAlias,
  registerBuiltinAliases,
  runAlias,
} from './alias'

describe('alias — registry + factory', () => {
  beforeEach(() => {
    clearRegistry()
    vi.useFakeTimers()
  })
  afterEach(() => {
    clearRegistry()
    vi.useRealTimers()
  })

  // ── Registry ────────────────────────────────────────────────────────────────

  it('registerAlias + getAlias : round-trip de config', () => {
    registerAlias({ name: 'my-job', maxRetries: 2, backoffMs: 100 })
    const config = getAlias('my-job')
    expect(config.name).toBe('my-job')
    expect(config.maxRetries).toBe(2)
  })

  it('getAlias lève AliasNotFoundError pour un alias inconnu', () => {
    expect(() => getAlias('unknown')).toThrow(AliasNotFoundError)
  })

  it('listAliases retourne les noms enregistrés', () => {
    registerAlias({ name: 'a' })
    registerAlias({ name: 'b' })
    expect(listAliases()).toContain('a')
    expect(listAliases()).toContain('b')
  })

  it('clearRegistry vide le registry', () => {
    registerAlias({ name: 'x' })
    clearRegistry()
    expect(listAliases()).toHaveLength(0)
  })

  // ── Validation ─────────────────────────────────────────────────────────────

  it.each([
    [{ name: '' }, 'Alias name must be a non-empty string'],
    [{ name: 'x', maxRetries: -1 }, 'maxRetries must be a non-negative integer'],
    [{ name: 'x', maxRetries: 1.5 }, 'maxRetries must be a non-negative integer'],
    [{ name: 'x', backoffMs: 0 }, 'backoffMs must be > 0'],
    [{ name: 'x', timeoutMs: -100 }, 'timeoutMs must be > 0'],
    [{ name: 'x', exponentialFactor: 0.5 }, 'exponentialFactor must be >= 1'],
  ])('validation config invalide : %o → %s', (config, expectedMsg) => {
    expect(() => registerAlias(config)).toThrow(AliasConfigError)
    expect(() => registerAlias(config)).toThrow(expectedMsg)
  })

  // ── registerBuiltinAliases ─────────────────────────────────────────────────

  it('registerBuiltinAliases enregistre les 3 templates métier', () => {
    registerBuiltinAliases()
    const names = listAliases()
    expect(names).toContain('stripe-capture')
    expect(names).toContain('mission-sync')
    expect(names).toContain('webhook-retry')
  })

  it('registerBuiltinAliases est idempotent (ré-enregistrement sans erreur)', () => {
    expect(() => {
      registerBuiltinAliases()
      registerBuiltinAliases()
    }).not.toThrow()
  })

  // ── runAlias ───────────────────────────────────────────────────────────────

  it('runAlias exécute fn et retourne son résultat', async () => {
    registerAlias({ name: 'simple', maxRetries: 0 })
    const fn = vi.fn().mockResolvedValue('done')
    const result = await runAlias('simple', fn)
    expect(result).toBe('done')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runAlias transmet idempotencyKey à fn', async () => {
    registerAlias({ name: 'with-key', maxRetries: 0 })
    const fn = vi.fn().mockResolvedValue('ok')
    await runAlias('with-key', fn, { idempotencyKey: 'idem-42' })
    expect(fn).toHaveBeenCalledWith('idem-42')
  })

  it('runAlias lève AliasNotFoundError pour un alias inconnu', async () => {
    await expect(runAlias('ghost', async () => 'x')).rejects.toThrow(AliasNotFoundError)
  })

  it("runAlias réessaie avec le profil de l'alias (backoffMs, maxRetries)", async () => {
    registerAlias({ name: 'retry-alias', maxRetries: 2, backoffMs: 50 })
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('flaky'))
      .mockResolvedValue('ok')

    const promise = runAlias('retry-alias', fn)
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  // ── Collision / idempotence ────────────────────────────────────────────────

  it(
    '[COLLISION] deux appels concurrents avec la même clé : fn reçoit la clé deux fois,' +
    ' pas de crash, résultats cohérents',
    async () => {
      registerAlias({ name: 'idempotent-alias', maxRetries: 0 })

      const received: Array<string | undefined> = []
      let call = 0

      // Simule un fn idempotent (comme un Prisma upsert) :
      // - 1er appel → action réelle ("created")
      // - 2ème appel → no-op ("exists")
      const fn = vi.fn().mockImplementation(async (key: string | undefined) => {
        received.push(key)
        return ++call === 1 ? 'created' : 'exists'
      })

      const [r1, r2] = await Promise.all([
        runAlias('idempotent-alias', fn, { idempotencyKey: 'key-abc' }),
        runAlias('idempotent-alias', fn, { idempotencyKey: 'key-abc' }),
      ])

      // Les deux calls terminent sans erreur.
      expect(r1).toMatch(/created|exists/)
      expect(r2).toMatch(/created|exists/)
      // fn a reçu la clé d'idempotence sur chaque invocation.
      expect(received).toEqual(['key-abc', 'key-abc'])
      // Pas de corruption : un résultat est "created", l'autre "exists".
      expect(new Set([r1, r2])).toEqual(new Set(['created', 'exists']))
    },
  )

  it(
    '[COLLISION] deux appels concurrents sans clé : fn invoqué deux fois indépendamment',
    async () => {
      registerAlias({ name: 'no-key-alias', maxRetries: 0 })
      const fn = vi.fn().mockResolvedValue('ok')

      await Promise.all([
        runAlias('no-key-alias', fn),
        runAlias('no-key-alias', fn),
      ])

      expect(fn).toHaveBeenCalledTimes(2)
      expect(fn).toHaveBeenCalledWith(undefined)
    },
  )
})
