import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { triggerReconciliation } from '../trigger-reconciliation'
import { runReconciliation } from '../../workers/reconciliation'
import type { ReconciliationAlert } from '../../workers/reconciliation'
import { prisma } from '../../db'

/**
 * Codes de sortie du déclencheur CLI/Cron (src/scripts/trigger-reconciliation.ts).
 *
 * Unitaire et hermétique : runReconciliation et ../db sont MOCKÉS — aucune DB,
 * aucun Stripe (STRIPE_SECRET_KEY vide → client omis, invariants DB seuls).
 *
 * Contrat testé : triggerReconciliation() RÉSOUT le code que le wrapper
 * `require.main` transmet à process.exit(code). On asserte le code retourné
 * (source de vérité) + la fermeture de connexion en finally.
 *   0 = run OK (avec ou sans alertes, flag OFF)
 *   1 = run en échec (exception)
 *   2 = alertes détectées ET RECONCILIATION_FAIL_ON_ALERT=1
 */

vi.mock('../../workers/reconciliation', () => ({ runReconciliation: vi.fn() }))
vi.mock('../../db', () => ({ prisma: { $disconnect: vi.fn(() => Promise.resolve()) } }))

const mockRun = vi.mocked(runReconciliation)
const mockDisconnect = vi.mocked(prisma.$disconnect)

const criticalAlert: ReconciliationAlert = {
  code: 'LEDGER_INVARIANT_BROKEN',
  message: 'Σ(CAPTURE) != capturedAmountCents',
  details: { escrowId: 'esc_1' },
  severity: 'critical',
}

describe('triggerReconciliation — codes de sortie CLI/Cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('DATABASE_URL', 'postgresql://mocked-db') // truthy → passe la garde
    vi.stubEnv('STRIPE_SECRET_KEY', '') // falsy → pas de client Stripe
    vi.stubEnv('RECONCILIATION_FAIL_ON_ALERT', '') // flag OFF par défaut
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('(1) succès, aucune alerte → 0', async () => {
    mockRun.mockResolvedValue([])

    expect(await triggerReconciliation()).toBe(0)
    expect(mockRun).toHaveBeenCalledOnce()
    expect(mockDisconnect).toHaveBeenCalledOnce() // finally : connexion fermée
  })

  it('(2) alertes détectées, flag OFF → 0 (alertes émises au sink, run non bloquant)', async () => {
    mockRun.mockResolvedValue([criticalAlert])

    expect(await triggerReconciliation()).toBe(0)
    expect(mockDisconnect).toHaveBeenCalledOnce()
  })

  it('(3) alertes détectées + RECONCILIATION_FAIL_ON_ALERT=1 → 2', async () => {
    vi.stubEnv('RECONCILIATION_FAIL_ON_ALERT', '1')
    mockRun.mockResolvedValue([criticalAlert])

    expect(await triggerReconciliation()).toBe(2)
    expect(mockDisconnect).toHaveBeenCalledOnce()
  })

  it('(4) run en échec (exception) → 1, connexion fermée malgré le crash', async () => {
    mockRun.mockRejectedValue(new Error('DB down'))

    expect(await triggerReconciliation()).toBe(1)
    expect(mockDisconnect).toHaveBeenCalledOnce() // le finally s'exécute
  })
})
