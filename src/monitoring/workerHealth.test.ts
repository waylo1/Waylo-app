import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWorkerMetrics, startWorkerHealthLoop } from './workerHealth'

/**
 * workerHealth — métriques OutboxEvent en LECTURE SEULE.
 *  (1) compte pending/failed/stale + log.info systématique ;
 *  (2) FAILED > 0 → log.warn ;
 *  (3) stalePending > 0 → log.warn avec seuil ;
 *  (4) tout à zéro → info seul, aucun warn ;
 *  (5) sans logger → ne throw pas, renvoie les métriques ;
 *  (6) startWorkerHealthLoop déclenche getWorkerMetrics périodiquement.
 */

const mockCount = vi.fn()
const mockPrisma = { outboxEvent: { count: mockCount } } as never
const mockLog = { info: vi.fn(), warn: vi.fn() }

const NOW = new Date('2026-06-22T12:00:00.000Z')

/** Pilote les 3 counts par leur clause where (status + createdAt). */
function stubCounts({ pending = 0, failed = 0, stale = 0 }) {
  mockCount.mockImplementation(async ({ where }: { where: { status: string; createdAt?: unknown } }) => {
    if (where.status === 'PENDING' && where.createdAt) return stale
    if (where.status === 'PENDING') return pending
    if (where.status === 'FAILED') return failed
    return 0
  })
}

describe('getWorkerMetrics — santé OutboxEvent (lecture seule)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubCounts({})
  })

  it('(1) compte les statuts et logue les métriques globales', async () => {
    stubCounts({ pending: 3, failed: 0, stale: 0 })

    const metrics = await getWorkerMetrics(mockPrisma, mockLog, NOW)

    expect(metrics).toEqual({
      pending: 3,
      failed: 0,
      stalePending: 0,
      collectedAt: NOW.toISOString(),
    })
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'WORKER_HEALTH', pending: 3, failed: 0 }),
      expect.any(String),
    )
    // Aucune écriture : seul count est appelé (lecture seule).
    expect(mockCount).toHaveBeenCalledTimes(3)
  })

  it('(2) FAILED > 0 → warning', async () => {
    stubCounts({ pending: 1, failed: 2, stale: 0 })

    await getWorkerMetrics(mockPrisma, mockLog, NOW)

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'WORKER_HEALTH', failed: 2 }),
      expect.stringContaining('FAILED'),
    )
  })

  it('(3) PENDING vieux de plus de 10 min → warning avec seuil', async () => {
    stubCounts({ pending: 5, failed: 0, stale: 4 })

    await getWorkerMetrics(mockPrisma, mockLog, NOW)

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'WORKER_HEALTH', stalePending: 4, thresholdMinutes: 10 }),
      expect.stringContaining('10 minutes'),
    )
  })

  it('(4) tout à zéro → info seulement, aucun warn', async () => {
    stubCounts({ pending: 0, failed: 0, stale: 0 })

    await getWorkerMetrics(mockPrisma, mockLog, NOW)

    expect(mockLog.info).toHaveBeenCalledTimes(1)
    expect(mockLog.warn).not.toHaveBeenCalled()
  })

  it('(5) sans logger → ne throw pas, renvoie les métriques', async () => {
    stubCounts({ pending: 7, failed: 1, stale: 2 })

    const metrics = await getWorkerMetrics(mockPrisma, undefined, NOW)

    expect(metrics).toMatchObject({ pending: 7, failed: 1, stalePending: 2 })
  })

  it('(6) startWorkerHealthLoop déclenche getWorkerMetrics périodiquement', async () => {
    vi.useFakeTimers()
    try {
      stubCounts({ pending: 1 })
      const timer = startWorkerHealthLoop(mockPrisma, mockLog, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(mockCount).toHaveBeenCalled()
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })
})
