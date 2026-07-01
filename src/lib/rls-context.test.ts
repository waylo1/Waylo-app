import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../db'
import { withRlsContext } from './rls-context'

/**
 * Câblage shadow-mode de `withRlsContext` — migration `20260701160000_rls_shadow_observability`.
 *
 * Le rôle de connexion local (`flipsync`, BYPASSRLS=true) ne permet pas de tester
 * l'enforcement RLS réel ici (couvert manuellement sur prod via `waylo_user`,
 * cf. docs/security-invariants.md). `fn` lit donc directement le GUC
 * `app.bypass_rls` pour simuler un écart déterministe et valider la MÉCANIQUE
 * (savepoint, double exécution, log conditionnel, restauration du GUC).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const PREFIX = 'test.rls-context.'

afterAll(async () => {
  await prisma.featureFlag.deleteMany({ where: { key: { startsWith: PREFIX } } })
  await prisma.rlsShadowMismatch.deleteMany({ where: { flagKey: { startsWith: PREFIX } } })
  await prisma.$disconnect()
})

// `fn` simule une lecture dont le résultat dépend du GUC posé par withRlsContext —
// vide sous enforce (app.bypass_rls='off'), non-vide sous bypass ('on'/absent).
const gucDependentRead = async (tx: Parameters<Parameters<typeof withRlsContext>[1]>[0]) => {
  const rows = await tx.$queryRaw<Array<{ v: number }>>`
    SELECT 1 AS v WHERE current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
  `
  return rows
}

describe('withRlsContext — shadow-mode mismatch logging', () => {
  it('(1) mode shadow + readOnly + écart simulé → un mismatch loggé', async () => {
    const key = `${PREFIX}mismatch`
    await prisma.featureFlag.create({ data: { key, mode: 'shadow' } })

    const result = await withRlsContext(
      { userId: 'user-shadow-1', flagKey: key, readOnly: true },
      gucDependentRead,
    )

    // Comportement réel inchangé : shadow ⇒ bypass actif ⇒ résultat non vide servi à l'appelant.
    expect(result).toHaveLength(1)

    const logged = await prisma.rlsShadowMismatch.findMany({ where: { flagKey: key } })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      userId: 'user-shadow-1',
      wouldEnforceAllow: false,
      actualBypassAllow: true,
    })
  })

  it('(2) mode shadow + readOnly=false (défaut) → aucun probe, aucun log', async () => {
    const key = `${PREFIX}no-probe`
    await prisma.featureFlag.create({ data: { key, mode: 'shadow' } })

    await withRlsContext({ userId: 'user-shadow-2', flagKey: key }, gucDependentRead)

    const logged = await prisma.rlsShadowMismatch.findMany({ where: { flagKey: key } })
    expect(logged).toHaveLength(0)
  })

  it('(3) mode off → aucun probe même avec readOnly=true (pas en shadow)', async () => {
    const key = `${PREFIX}mode-off`
    await prisma.featureFlag.create({ data: { key, mode: 'off' } })

    await withRlsContext({ userId: 'user-shadow-3', flagKey: key, readOnly: true }, gucDependentRead)

    const logged = await prisma.rlsShadowMismatch.findMany({ where: { flagKey: key } })
    expect(logged).toHaveLength(0)
  })

  it('(4) mode shadow + readOnly + fn qui throw sous enforce → traité comme refus (loggé)', async () => {
    const key = `${PREFIX}throws-under-enforce`
    await prisma.featureFlag.create({ data: { key, mode: 'shadow' } })

    const throwsUnderEnforce = async (tx: Parameters<Parameters<typeof withRlsContext>[1]>[0]) => {
      const rows = await tx.$queryRaw<Array<{ bypassed: boolean }>>`
        SELECT current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off' AS bypassed
      `
      if (!rows[0]?.bypassed) throw new Error('MISSION_NOT_FOUND')
      return rows
    }

    const result = await withRlsContext(
      { userId: 'user-shadow-4', flagKey: key, readOnly: true },
      throwsUnderEnforce,
    )
    // Résultat réel (bypass) inchangé et servi normalement à l'appelant.
    expect(result).toHaveLength(1)

    const logged = await prisma.rlsShadowMismatch.findMany({ where: { flagKey: key } })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ wouldEnforceAllow: false, actualBypassAllow: true })
  })
})
