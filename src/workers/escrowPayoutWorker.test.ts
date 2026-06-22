import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * escrowPayoutWorker — orchestration du payout escrow (OutboxEvent READY_FOR_PAYOUT).
 * Test UNITAIRE : prisma et captureEscrowFunds mockés.
 *
 *  (1) event PENDING → claim (attempts++) → captureEscrowFunds → SETTLED + log.info ;
 *  (2) queue vide → sort proprement (0 settled, 0 failed) ;
 *  (3) erreur Stripe (sous MAX) → PENDING (retry) + log.error, attempts conservé ;
 *  (4) erreur Stripe (seuil MAX atteint) → FAILED terminal + log.error ;
 *  (5) EscrowCaptureError (ESCROW_NOT_HELD) → même comportement que transient ;
 *  (6) claim perdu (FOR UPDATE SKIP LOCKED — concurrent) → loop s'arrête proprement.
 */

const { mockPrisma, mockCapture, mockQueryRaw } = vi.hoisted(() => {
  const mockQueryRaw = vi.fn()
  const mockPrisma = {
    $transaction: vi.fn(),
    outboxEvent: { update: vi.fn() },
    mission: { findUnique: vi.fn() },
  }
  const mockCapture = vi.fn()
  return { mockPrisma, mockCapture, mockQueryRaw }
})

vi.mock('../db', () => ({ prisma: mockPrisma }))
vi.mock('../services/escrowService', () => ({
  captureEscrowFunds: mockCapture,
  EscrowCaptureError: class EscrowCaptureError extends Error {
    constructor(readonly code: string) { super(code); this.name = 'EscrowCaptureError' }
  },
}))

import { runEscrowPayoutWorkerOnce } from './escrowPayoutWorker'
import { EscrowCaptureError } from '../services/escrowService'

const fakeStripe = {} as never

const mockLog = { info: vi.fn(), error: vi.fn() }

const baseEvent = { id: 'evt_1', missionId: 'm1', attempts: 1 }

function makeDeps(overrides = {}) {
  return { prisma: mockPrisma as never, stripe: fakeStripe, log: mockLog, ...overrides }
}

describe('runEscrowPayoutWorkerOnce — payout escrow worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Par défaut : prisma.$transaction exécute le callback avec tx qui contient $queryRaw.
    mockPrisma.$transaction.mockImplementation(
      async (cb: (tx: { $queryRaw: typeof mockQueryRaw; outboxEvent: { update: typeof vi.fn } }) => unknown) =>
        cb({ $queryRaw: mockQueryRaw, outboxEvent: mockPrisma.outboxEvent }),
    )
    // Par défaut : un event PENDING éligible (batchLimit: 1 dans chaque test pour borner la boucle).
    mockQueryRaw.mockResolvedValue([{ id: 'evt_1' }])
    mockPrisma.outboxEvent.update.mockResolvedValue(baseEvent)
    // Par défaut : mission NON litigieuse → la garde IN_DISPUTE laisse passer le payout.
    mockPrisma.mission.findUnique.mockResolvedValue({ status: 'COMPLETED_BY_BUYER' })
    mockCapture.mockResolvedValue({
      escrowId: 'escrow_1',
      stripePaymentIntentId: 'pi_test',
      capturedAmountCents: 15_000,
    })
  })

  it('(1) event PENDING → claim + capture → SETTLED + log.info', async () => {
    const res = await runEscrowPayoutWorkerOnce(makeDeps({ batchLimit: 1 }))

    // Claim : transaction avec FOR UPDATE SKIP LOCKED + update attempts
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    // captureEscrowFunds appelé avec missionId + stripe (hors transaction)
    expect(mockCapture).toHaveBeenCalledWith('m1', fakeStripe)
    // Verdict SETTLED dans un update hors transaction
    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SETTLED', lastError: null }) }),
    )
    // Audit log structuré + métrique de latence par capture.
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'm1',
        capturedAmountCents: 15_000,
        captureDurationMs: expect.any(Number),
      }),
      expect.stringContaining('capture Stripe réussie'),
    )
    expect(res).toEqual({ settled: 1, failed: 0 })
  })

  it('(2) queue vide → sort proprement sans appel Stripe', async () => {
    mockQueryRaw.mockResolvedValueOnce([]) // FOR UPDATE SKIP LOCKED → rien

    const res = await runEscrowPayoutWorkerOnce(makeDeps())

    expect(mockCapture).not.toHaveBeenCalled()
    expect(res).toEqual({ settled: 0, failed: 0 })
  })

  it('(3) erreur Stripe sous seuil max → event re-PENDING (retry) + log.error', async () => {
    mockCapture.mockRejectedValueOnce(new Error('stripe timeout'))
    // attempts post-claim = 1, maxAttempts = 5 → pas terminal
    mockPrisma.outboxEvent.update.mockResolvedValueOnce({ ...baseEvent, attempts: 1 })

    const res = await runEscrowPayoutWorkerOnce(makeDeps({ batchLimit: 1 }))

    const verdictCall = mockPrisma.outboxEvent.update.mock.calls.find(
      ([arg]) => arg.data?.status !== undefined,
    )
    expect(verdictCall?.[0].data).toMatchObject({ status: 'PENDING', lastError: 'stripe timeout' })
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'WORKER_ERROR',
        worker: 'escrowPayoutWorker',
        attempt: 1,
        maxAttempts: 5,
        captureDurationMs: expect.any(Number),
      }),
      expect.stringContaining('retry'),
    )
    expect(res).toEqual({ settled: 0, failed: 1 })
  })

  it('(4) erreur Stripe au seuil max → FAILED terminal + log.error ABANDONNÉ', async () => {
    mockCapture.mockRejectedValueOnce(new Error('card_declined'))
    // claims retourne attempts = maxAttempts (5)
    mockPrisma.outboxEvent.update.mockResolvedValueOnce({ ...baseEvent, attempts: 5 })

    const res = await runEscrowPayoutWorkerOnce(makeDeps({ maxAttempts: 5, batchLimit: 1 }))

    const verdictCall = mockPrisma.outboxEvent.update.mock.calls.find(
      ([arg]) => arg.data?.status !== undefined,
    )
    expect(verdictCall?.[0].data).toMatchObject({ status: 'FAILED' })
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'WORKER_ERROR', isEscrowError: false }),
      expect.stringContaining('ABANDONNÉE'),
    )
    expect(res).toEqual({ settled: 0, failed: 1 })
  })

  it('(5) EscrowCaptureError (ESCROW_NOT_HELD) → logué comme erreur escrow, retry', async () => {
    mockCapture.mockRejectedValueOnce(new EscrowCaptureError('ESCROW_NOT_HELD'))

    await runEscrowPayoutWorkerOnce(makeDeps({ batchLimit: 1 }))

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ isEscrowError: true }),
      expect.any(String),
    )
  })

  it('(6) claim renvoie null (queue vide au SKIP LOCKED) → 0 traitements', async () => {
    mockQueryRaw.mockResolvedValue([]) // aucun event éligible

    const res = await runEscrowPayoutWorkerOnce(makeDeps())

    expect(mockCapture).not.toHaveBeenCalled()
    expect(res).toEqual({ settled: 0, failed: 0 })
  })

  it('(7) mission IN_DISPUTE (course après claim) → payout BLOQUÉ, event re-PENDING, aucune capture', async () => {
    // Litige ouvert entre le claim et la vérification : la garde JS rattrape.
    mockPrisma.mission.findUnique.mockResolvedValueOnce({ status: 'IN_DISPUTE' })

    const res = await runEscrowPayoutWorkerOnce(makeDeps({ batchLimit: 1 }))

    // Aucun appel Stripe : la garde a court-circuité avant la capture.
    expect(mockCapture).not.toHaveBeenCalled()
    // Event relâché en PENDING sans pénaliser le compteur (decrement de l'incrément du claim).
    const blockedCall = mockPrisma.outboxEvent.update.mock.calls.find(
      ([arg]) => arg.data?.lastError === 'BLOCKED_IN_DISPUTE',
    )
    expect(blockedCall?.[0].data).toMatchObject({
      status: 'PENDING',
      attempts: { decrement: 1 },
    })
    // Ni settled ni failed : un payout bloqué n'est pas un échec.
    expect(res).toEqual({ settled: 0, failed: 0 })
  })
})
