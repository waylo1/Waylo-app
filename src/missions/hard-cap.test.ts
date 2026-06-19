import { describe, expect, it } from 'vitest'
import { substitutionCeilingCents, substitutionHardCapCents } from './mission-common'

/**
 * Hard Cap 150% (audit robustesse) — backstop absolu de substitution.
 *
 * Borne dure indépendante du plafond opérationnel 120% (`substitutionCeilingCents`),
 * appliquée aux points de mouvement d'argent (capture `escrow.service`, autorisation
 * JIT — cf. `issuing-hard-cap.test.ts`). Tests unitaires : valeur exacte + invariant
 * de non-déclenchement sur le flux nominal.
 */
describe('Hard Cap substitution 150% — backstop', () => {
  it('= floor(budget × 1,5), centimes Int strict (jamais Float)', () => {
    expect(substitutionHardCapCents(10_000)).toBe(15_000)
    expect(substitutionHardCapCents(40_000)).toBe(60_000)
    expect(substitutionHardCapCents(999)).toBe(1_498) // floor(1498.5)
    expect(substitutionHardCapCents(0)).toBe(0)
  })

  it('invariant : plafond 120% ≤ backstop 150% → le backstop ne se déclenche JAMAIS sur le flux nominal', () => {
    for (const budget of [1, 999, 10_000, 40_000, 123_457, 1_000_000]) {
      expect(substitutionCeilingCents(budget)).toBeLessThanOrEqual(substitutionHardCapCents(budget))
    }
  })
})
