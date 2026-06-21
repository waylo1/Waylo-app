import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '../generated/prisma'

/**
 * sealReceipt — validation métier + scellement d'un reçu OCR.
 * Test UNITAIRE : Prisma mocké (`../db`), `isUniqueViolation` réel (fonction pure).
 *
 * Branches :
 *  (1) match strict (purchaseAmountCents === totalAmount) → Receipt créé + CONSUMED ;
 *  (2) purchaseAmountCents null → FAILED PURCHASE_AMOUNT_MISSING (aucun Receipt) ;
 *  (3) écart strict → FAILED PRICE_MISMATCH (aucun Receipt) ;
 *  (4) Receipt déjà scellé (pré-check) → FAILED RECEIPT_ALREADY_SEALED (pas d'écrasement) ;
 *  (5) job absent → SKIPPED JOB_NOT_FOUND ;
 *  (6) job pas COMPLETED → SKIPPED NOT_COMPLETED ;
 *  (7) course : create viole l'unicité (P2002) → FAILED RECEIPT_ALREADY_SEALED (hors tx).
 */

const { mockPrisma, mockTx } = vi.hoisted(() => {
  const mockTx = {
    receiptExtractionOutbox: { findUnique: vi.fn(), updateMany: vi.fn() },
    receipt: { findUnique: vi.fn(), create: vi.fn() },
    mission: { findUnique: vi.fn(), updateMany: vi.fn() },
    outboxEvent: { create: vi.fn() },
    adminAuditLog: { create: vi.fn() },
  }
  const mockPrisma = {
    $transaction: vi.fn(),
    receiptExtractionOutbox: { updateMany: vi.fn() },
  }
  return { mockPrisma, mockTx }
})

vi.mock('../db', () => ({ prisma: mockPrisma }))

import {
  sealReceipt,
  confirmReception,
  DeliveryProofError,
  ReceptionConflictError,
} from './escrowService'

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  status: 'COMPLETED',
  imageData: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  resultJson: { totalAmount: 1500, currency: 'EUR' },
  mission: { id: 'm1', purchaseAmountCents: 1500 },
  ...over,
})

describe('sealReceipt — validation métier + scellement OCR', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx))
    mockTx.receiptExtractionOutbox.findUnique.mockResolvedValue(job())
    mockTx.receiptExtractionOutbox.updateMany.mockResolvedValue({ count: 1 })
    mockTx.receipt.findUnique.mockResolvedValue(null)
    mockTx.receipt.create.mockResolvedValue({ id: 'rcpt_1' })
    mockPrisma.receiptExtractionOutbox.updateMany.mockResolvedValue({ count: 1 })
  })

  it('(1) match strict → Receipt scellé + CONSUMED', async () => {
    const res = await sealReceipt('job_1')

    expect(mockTx.receipt.create).toHaveBeenCalledTimes(1)
    const createArg = mockTx.receipt.create.mock.calls[0][0]
    expect(createArg.data).toMatchObject({ missionId: 'm1', totalTtcCents: 1500 })
    // sha256 hex (64 chars) posé sur les deux champs (sceau serveur).
    expect(createArg.data.sha256Server).toMatch(/^[0-9a-f]{64}$/)
    expect(createArg.data.sha256Client).toBe(createArg.data.sha256Server)
    // Transition conditionnelle COMPLETED → CONSUMED.
    expect(mockTx.receiptExtractionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'job_1', status: 'COMPLETED' },
      data: { status: 'CONSUMED' },
    })
    expect(res).toEqual({ outcome: 'CONSUMED', receiptId: 'rcpt_1' })
  })

  it('(2) purchaseAmountCents null → FAILED PURCHASE_AMOUNT_MISSING, aucun Receipt', async () => {
    mockTx.receiptExtractionOutbox.findUnique.mockResolvedValue(
      job({ mission: { id: 'm1', purchaseAmountCents: null } }),
    )

    const res = await sealReceipt('job_1')

    expect(mockTx.receipt.create).not.toHaveBeenCalled()
    expect(mockTx.receiptExtractionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'job_1', status: 'COMPLETED' },
      data: { status: 'FAILED', lastError: 'PURCHASE_AMOUNT_MISSING' },
    })
    expect(res).toEqual({ outcome: 'FAILED', reason: 'PURCHASE_AMOUNT_MISSING' })
  })

  it('(3) écart strict → FAILED PRICE_MISMATCH, aucun Receipt', async () => {
    mockTx.receiptExtractionOutbox.findUnique.mockResolvedValue(
      job({ resultJson: { totalAmount: 1500 }, mission: { id: 'm1', purchaseAmountCents: 2000 } }),
    )

    const res = await sealReceipt('job_1')

    expect(mockTx.receipt.create).not.toHaveBeenCalled()
    expect(res).toEqual({ outcome: 'FAILED', reason: 'PRICE_MISMATCH' })
    expect(mockTx.receiptExtractionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'job_1', status: 'COMPLETED' },
      data: { status: 'FAILED', lastError: 'PRICE_MISMATCH' },
    })
  })

  it('(4) Receipt déjà scellé → FAILED RECEIPT_ALREADY_SEALED, pas d’écrasement', async () => {
    mockTx.receipt.findUnique.mockResolvedValue({ id: 'rcpt_existing' })

    const res = await sealReceipt('job_1')

    expect(mockTx.receipt.create).not.toHaveBeenCalled()
    expect(res).toEqual({ outcome: 'FAILED', reason: 'RECEIPT_ALREADY_SEALED' })
  })

  it('(5) job absent → SKIPPED JOB_NOT_FOUND', async () => {
    mockTx.receiptExtractionOutbox.findUnique.mockResolvedValue(null)

    const res = await sealReceipt('job_1')

    expect(res).toEqual({ outcome: 'SKIPPED', reason: 'JOB_NOT_FOUND' })
    expect(mockTx.receipt.create).not.toHaveBeenCalled()
    expect(mockTx.receiptExtractionOutbox.updateMany).not.toHaveBeenCalled()
  })

  it('(6) job pas COMPLETED → SKIPPED NOT_COMPLETED (idempotence)', async () => {
    mockTx.receiptExtractionOutbox.findUnique.mockResolvedValue(job({ status: 'CONSUMED' }))

    const res = await sealReceipt('job_1')

    expect(res).toEqual({ outcome: 'SKIPPED', reason: 'NOT_COMPLETED' })
    expect(mockTx.receipt.create).not.toHaveBeenCalled()
  })

  it('(7) course de scellement (P2002) → FAILED RECEIPT_ALREADY_SEALED hors tx', async () => {
    mockTx.receipt.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5.22.0' }),
    )

    const res = await sealReceipt('job_1')

    expect(res).toEqual({ outcome: 'FAILED', reason: 'RECEIPT_ALREADY_SEALED' })
    // Bascule FAILED via le client de BASE (hors transaction avortée).
    expect(mockPrisma.receiptExtractionOutbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'job_1', status: 'COMPLETED' },
      data: { status: 'FAILED', lastError: 'RECEIPT_ALREADY_SEALED' },
    })
  })
})

/**
 * confirmReception — confirmation de réception acheteur (transaction unique).
 * Test UNITAIRE : Prisma mocké (`../db`).
 *
 *  (1) preuve OK (sans code consigne) → COMPLETED_BY_BUYER + OutboxEvent READY_FOR_PAYOUT + audit ;
 *  (2) preuve OK matchant le code consigne → succès ;
 *  (3) preuve ≠ code consigne → DeliveryProofError INVALID, ROLLBACK (aucune écriture) ;
 *  (4) preuve vide → DeliveryProofError MISSING (avant transaction) ;
 *  (5) mission absente → ReceptionConflictError MISSION_NOT_FOUND ;
 *  (6) appelant non-acheteur → ReceptionConflictError NOT_MISSION_BUYER ;
 *  (7) mission hors AWAITING_CONFIRMATION → ReceptionConflictError.
 */
const missionRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'm1',
  status: 'AWAITING_CONFIRMATION',
  buyerId: 'buyer_1',
  dropOffAccessCode: null,
  ...over,
})

describe('confirmReception — confirmation de réception acheteur', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockTx) => unknown) => cb(mockTx))
    mockTx.mission.findUnique.mockResolvedValue(missionRow())
    mockTx.mission.updateMany.mockResolvedValue({ count: 1 })
    mockTx.outboxEvent.create.mockResolvedValue({ id: 'evt_1' })
    mockTx.adminAuditLog.create.mockResolvedValue({ id: 'audit_1' })
  })

  it('(1) preuve valide (sans code consigne) → COMPLETED_BY_BUYER + OutboxEvent + audit', async () => {
    const res = await confirmReception('m1', 'buyer_1', 'PROOF-123')

    // Transition conditionnelle anti-TOCTOU + scellement du hash de preuve.
    const upd = mockTx.mission.updateMany.mock.calls[0][0]
    expect(upd.where).toEqual({ id: 'm1', status: 'AWAITING_CONFIRMATION' })
    expect(upd.data.status).toBe('COMPLETED_BY_BUYER')
    expect(upd.data.deliveryProofHash).toMatch(/^[0-9a-f]{64}$/)
    expect(upd.data.receptionConfirmedAt).toBeInstanceOf(Date)
    // Handoff paiement : OutboxEvent READY_FOR_PAYOUT (PENDING par défaut DB).
    expect(mockTx.outboxEvent.create).toHaveBeenCalledWith({
      data: {
        missionId: 'm1',
        type: 'READY_FOR_PAYOUT',
        payload: { deliveryProofHash: expect.stringMatching(/^[0-9a-f]{64}$/), confirmedBy: 'buyer_1' },
      },
      select: { id: true },
    })
    // Audit append-only.
    expect(mockTx.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'buyer_1', action: 'CONFIRM_RECEPTION', missionId: 'm1' },
    })
    expect(res).toEqual({ missionId: 'm1', status: 'COMPLETED_BY_BUYER', outboxEventId: 'evt_1' })
  })

  it('(2) preuve correspondant au code consigne → succès', async () => {
    mockTx.mission.findUnique.mockResolvedValue(missionRow({ dropOffAccessCode: 'LOCKER-42' }))

    const res = await confirmReception('m1', 'buyer_1', 'LOCKER-42')

    expect(res.status).toBe('COMPLETED_BY_BUYER')
    expect(mockTx.mission.updateMany).toHaveBeenCalledTimes(1)
  })

  it('(3) preuve ≠ code consigne → INVALID, rollback (aucune écriture)', async () => {
    mockTx.mission.findUnique.mockResolvedValue(missionRow({ dropOffAccessCode: 'LOCKER-42' }))

    await expect(confirmReception('m1', 'buyer_1', 'WRONG')).rejects.toSatisfy(
      (e: unknown) => e instanceof DeliveryProofError && e.code === 'DELIVERY_PROOF_INVALID',
    )
    expect(mockTx.mission.updateMany).not.toHaveBeenCalled()
    expect(mockTx.outboxEvent.create).not.toHaveBeenCalled()
    expect(mockTx.adminAuditLog.create).not.toHaveBeenCalled()
  })

  it('(4) preuve vide → MISSING avant toute transaction', async () => {
    await expect(confirmReception('m1', 'buyer_1', '   ')).rejects.toSatisfy(
      (e: unknown) => e instanceof DeliveryProofError && e.code === 'DELIVERY_PROOF_MISSING',
    )
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
  })

  it('(5) mission absente → MISSION_NOT_FOUND', async () => {
    mockTx.mission.findUnique.mockResolvedValue(null)

    await expect(confirmReception('m1', 'buyer_1', 'PROOF')).rejects.toSatisfy(
      (e: unknown) => e instanceof ReceptionConflictError && e.code === 'MISSION_NOT_FOUND',
    )
  })

  it('(6) appelant non-acheteur → NOT_MISSION_BUYER (anti-IDOR)', async () => {
    await expect(confirmReception('m1', 'someone_else', 'PROOF')).rejects.toSatisfy(
      (e: unknown) => e instanceof ReceptionConflictError && e.code === 'NOT_MISSION_BUYER',
    )
    expect(mockTx.mission.updateMany).not.toHaveBeenCalled()
  })

  it('(7) mission hors AWAITING_CONFIRMATION → conflit', async () => {
    mockTx.mission.findUnique.mockResolvedValue(missionRow({ status: 'IN_PROGRESS' }))

    await expect(confirmReception('m1', 'buyer_1', 'PROOF')).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ReceptionConflictError && e.code === 'MISSION_NOT_AWAITING_CONFIRMATION',
    )
    expect(mockTx.outboxEvent.create).not.toHaveBeenCalled()
  })
})
