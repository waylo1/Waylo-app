import { describe, expect, it, vi } from 'vitest'
import { claimOutboxBatch } from './outbox-claim'
import type { PrismaClient } from '../generated/prisma'

/**
 * Tests unitaires de `claimOutboxBatch` — abstraction partagée du claim outbox.
 *
 * Vérifications :
 * (1) retour [] si selectIds renvoie aucune ligne (aucun callback appelé après)
 * (2) chaîne correcte : selectIds → updateAttempts(ids) → fetchClaimed(ids)
 *     dans la MÊME transaction (même objet tx passé aux 3 callbacks)
 * (3) retour du résultat de fetchClaimed tel quel
 *
 * Tests unitaires avec prisma.$transaction stubbé — pas de DB réelle. Le
 * comportement avec DB réelle est couvert par les tests d'intégration des
 * workers qui utilisent claimOutboxBatch (`disputeResolutionWorker.test.ts`,
 * `disputePenaltyWorker.test.ts`).
 */

function makePrisma(txCallback: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>): PrismaClient {
  return { $transaction: vi.fn().mockImplementation(txCallback) } as unknown as PrismaClient
}

describe('claimOutboxBatch', () => {
  it('(1) retourne [] sans appeler updateAttempts/fetchClaimed si selectIds renvoie []', async () => {
    const txMock = {}
    const prisma = makePrisma(fn => fn(txMock))

    const updateAttempts = vi.fn()
    const fetchClaimed = vi.fn()

    const result = await claimOutboxBatch(prisma, {
      selectIds: async () => [],
      updateAttempts,
      fetchClaimed,
    })

    expect(result).toEqual([])
    expect(updateAttempts).not.toHaveBeenCalled()
    expect(fetchClaimed).not.toHaveBeenCalled()
  })

  it('(2) chaîne selectIds → updateAttempts(ids) → fetchClaimed(ids) dans la même tx', async () => {
    const txMock = { marker: 'same-tx' }
    const prisma = makePrisma(fn => fn(txMock))

    const fakeRows = [{ id: 'id-a' }, { id: 'id-b' }]
    const fakeClaimed = [{ id: 'id-a', missionId: 'm-1', attempts: 1 }]

    const selectIds = vi.fn().mockResolvedValue(fakeRows)
    const updateAttempts = vi.fn().mockResolvedValue(undefined)
    const fetchClaimed = vi.fn().mockResolvedValue(fakeClaimed)

    const result = await claimOutboxBatch(prisma, { selectIds, updateAttempts, fetchClaimed })

    // Les 3 callbacks reçoivent le MÊME objet tx.
    expect(selectIds).toHaveBeenCalledWith(txMock)
    expect(updateAttempts).toHaveBeenCalledWith(txMock, ['id-a', 'id-b'])
    expect(fetchClaimed).toHaveBeenCalledWith(txMock, ['id-a', 'id-b'])
    expect(result).toEqual(fakeClaimed)
  })

  it('(3) retourne le résultat de fetchClaimed tel quel', async () => {
    const txMock = {}
    const prisma = makePrisma(fn => fn(txMock))

    const claimed = [
      { id: 'x', missionId: 'm', userId: 'u', amountCents: 15_000, attempts: 1, paymentMethodId: 'pm_x', customerId: null },
    ]
    const result = await claimOutboxBatch(prisma, {
      selectIds: async () => [{ id: 'x' }],
      updateAttempts: async () => {},
      fetchClaimed: async () => claimed,
    })
    expect(result).toBe(claimed)
  })
})
