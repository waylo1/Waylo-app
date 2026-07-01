import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../db'
import { FeatureGuard } from './feature-guard'

/**
 * Kill-switch du rollout RLS (off → shadow → enforce) — src/lib/feature-guard.ts.
 *
 * Une clé DÉDIÉE par cas (préfixe `test.feature-guard.*`) : le cache mémoire de
 * `FeatureGuard` est un singleton de MODULE (Map partagée entre tous les appels
 * du process) — réutiliser la même clé entre deux `it()` ferait lire le cache
 * laissé par le test précédent au lieu de l'état DB du cas courant. Les clés
 * `rls.missions`/`rls.wallets` (seedées par `add_feature_flags`) ne sont jamais
 * touchées ici.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const PREFIX = 'test.feature-guard.'

afterAll(async () => {
  await prisma.featureFlag.deleteMany({ where: { key: { startsWith: PREFIX } } })
  await prisma.$disconnect()
})

describe('FeatureGuard — kill-switch RLS', () => {
  it('(1) clé inconnue → "off" fail-safe (jamais enforce par défaut)', async () => {
    const mode = await FeatureGuard.mode(`${PREFIX}unknown`, 1_000)
    expect(mode).toBe('off')
  })

  it('(2) lit le mode réel en base (shadow)', async () => {
    const key = `${PREFIX}shadow-read`
    await prisma.featureFlag.create({ data: { key, mode: 'shadow' } })
    const mode = await FeatureGuard.mode(key, 2_000)
    expect(mode).toBe('shadow')
  })

  it('(3) lit le mode réel en base (enforce)', async () => {
    const key = `${PREFIX}enforce-read`
    await prisma.featureFlag.create({ data: { key, mode: 'enforce' } })
    const mode = await FeatureGuard.mode(key, 3_000)
    expect(mode).toBe('enforce')
  })

  it('(4) cache TTL : un changement DB n\'est PAS vu avant expiration du TTL (5s)', async () => {
    const key = `${PREFIX}ttl`
    await prisma.featureFlag.create({ data: { key, mode: 'enforce' } })
    const first = await FeatureGuard.mode(key, 10_000)
    expect(first).toBe('enforce')

    // Changement direct en base, MAIS cache encore chaud (< 5_000ms plus tard).
    await prisma.featureFlag.update({ where: { key }, data: { mode: 'off' } })
    const stillCached = await FeatureGuard.mode(key, 10_000 + 4_999)
    expect(stillCached).toBe('enforce') // cache, pas la DB

    const afterTtl = await FeatureGuard.mode(key, 10_000 + 5_001)
    expect(afterTtl).toBe('off') // TTL expiré → relecture DB
  })

  it('(5) kill() repasse "off" IMMÉDIATEMENT, même cache chaud (< TTL)', async () => {
    const key = `${PREFIX}kill-switch`
    await prisma.featureFlag.create({ data: { key, mode: 'enforce' } })
    const before = await FeatureGuard.mode(key, 20_000)
    expect(before).toBe('enforce') // cache peuplé à 'enforce'

    await FeatureGuard.kill(key, 'admin-test-id')

    // Même timestamp logique (cache TTL pas expiré) : kill() doit avoir évincé le cache.
    const after = await FeatureGuard.mode(key, 20_000 + 1)
    expect(after).toBe('off')

    const row = await prisma.featureFlag.findUniqueOrThrow({ where: { key } })
    expect(row.updatedBy).toBe('admin-test-id')
  })

  it('(6) valeur corrompue en base → "off" fail-safe, jamais de throw', async () => {
    const key = `${PREFIX}corrupted`
    await prisma.featureFlag.create({ data: { key, mode: 'not_a_valid_mode' } })
    const mode = await FeatureGuard.mode(key, 30_000)
    expect(mode).toBe('off')
  })

  it('(7) bypass() — off/shadow neutralisent RLS, seul enforce l\'active', () => {
    expect(FeatureGuard.bypass('off')).toBe(true)
    expect(FeatureGuard.bypass('shadow')).toBe(true)
    expect(FeatureGuard.bypass('enforce')).toBe(false)
  })
})
