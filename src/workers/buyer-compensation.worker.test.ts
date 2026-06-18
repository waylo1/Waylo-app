import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Worker de compensation acheteur — processBuyerCompensations().
 * Test UNITAIRE : Prisma mocké (`../db`) — aucune écriture DB. On exerce les 3 branches
 * de façon déterministe (le chemin d'échec n'est pas reproductible contre la vraie base :
 * aucune contrainte que le worker violerait).
 *
 * (1) PENDING → crédit Wallet (upsert), statut SETTLED, attempts +1, dans UNE $transaction ;
 * (2) échec avec attempts < 4 → statut reste PENDING, attempts +1, lastError stocké ;
 * (3) échec atteignant le seuil (nextAttempt >= 4) → statut FAILED.
 */

const { mockPrisma, mockTx } = vi.hoisted(() => {
  const mockTx = {
    wallet: { upsert: vi.fn() },
    buyerCompensationOutbox: { update: vi.fn() },
  }
  const mockPrisma = {
    buyerCompensationOutbox: { findMany: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  }
  return { mockPrisma, mockTx }
})

vi.mock('../db', () => ({ prisma: mockPrisma }))

const { processBuyerCompensations } = await import('./buyer-compensation.worker')

const COMPENSATION_CENTS = 13_800 // 120% de (10_000 + 1_500)

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'job_1',
  missionId: 'mission_1',
  buyerId: 'buyer_1',
  amountCents: COMPENSATION_CENTS,
  status: 'PENDING',
  attempts: 0,
  lastError: null,
  ...over,
})

describe('processBuyerCompensations — worker compensation acheteur', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // $transaction(cb) exécute le callback avec le tx mocké.
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) =>
      cb(mockTx)
    )
    mockTx.wallet.upsert.mockResolvedValue({ id: 'wallet_1' })
    mockTx.buyerCompensationOutbox.update.mockResolvedValue({})
    mockPrisma.buyerCompensationOutbox.update.mockResolvedValue({})
  })

  it('(1) PENDING → crédit Wallet + SETTLED + attempts +1 (dans une $transaction)', async () => {
    mockPrisma.buyerCompensationOutbox.findMany.mockResolvedValue([job({ attempts: 0 })])

    await processBuyerCompensations()

    // File PENDING bornée à 10.
    expect(mockPrisma.buyerCompensationOutbox.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
      take: 10,
    })
    // Tout passe par UNE transaction (atomicité crédit + transition).
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    // Crédit du Wallet acheteur (upsert : création ou incrément).
    expect(mockTx.wallet.upsert).toHaveBeenCalledWith({
      where: { userId: 'buyer_1' },
      create: { userId: 'buyer_1', balanceCents: COMPENSATION_CENTS },
      update: { balanceCents: { increment: COMPENSATION_CENTS } },
    })
    // Intention → SETTLED, attempts incrémenté.
    expect(mockTx.buyerCompensationOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job_1' },
      data: { status: 'SETTLED', attempts: 1 },
    })
    // Aucune écriture par la branche d'échec.
    expect(mockPrisma.buyerCompensationOutbox.update).not.toHaveBeenCalled()
  })

  it('(2) échec & attempts < 4 → reste PENDING, attempts +1, lastError stocké', async () => {
    mockPrisma.buyerCompensationOutbox.findMany.mockResolvedValue([job({ attempts: 1 })])
    mockTx.wallet.upsert.mockRejectedValueOnce(new Error('wallet credit failed'))

    await processBuyerCompensations()

    // Branche catch : ré-éligible (PENDING), attempts 1 → 2, erreur diagnostique.
    expect(mockPrisma.buyerCompensationOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job_1' },
      data: { status: 'PENDING', attempts: 2, lastError: 'wallet credit failed' },
    })
    // La transition SETTLED n'a PAS eu lieu.
    expect(mockTx.buyerCompensationOutbox.update).not.toHaveBeenCalled()
  })

  it('(3) échec atteignant le seuil (attempts 3 → 4) → FAILED', async () => {
    mockPrisma.buyerCompensationOutbox.findMany.mockResolvedValue([job({ attempts: 3 })])
    mockTx.wallet.upsert.mockRejectedValueOnce(new Error('fatal'))

    await processBuyerCompensations()

    expect(mockPrisma.buyerCompensationOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job_1' },
      data: { status: 'FAILED', attempts: 4, lastError: 'fatal' },
    })
  })
})
