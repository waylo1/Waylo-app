import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Worker d'extraction OCR — processReceiptOutbox().
 * Test UNITAIRE : Prisma mocké (`../db`) ET `processReceiptImage` mocké
 * (`../services/visionClient`) — on isole la MACHINE À ÉTATS du worker (claim,
 * verdict, classification d'échec, reclaim), pas le pipeline Vision (testé ailleurs).
 *
 * Branches couvertes :
 *  (1) PENDING → claim PENDING→PROCESSING (attempts +1) puis succès → COMPLETED + resultJson ;
 *  (2) claim perdu (count=0, ligne déjà prise) → AUCUNE extraction, aucun verdict ;
 *  (3) échec TRANSITOIRE (UNREADABLE_IMAGE), attempts < max → ré-éligible (PENDING) ;
 *  (4) échec DÉTERMINISTE de contenu (SCHEMA_MISMATCH) → FAILED immédiat ;
 *  (5) échec DÉTERMINISTE structurel (UnsupportedImageError) → FAILED immédiat ;
 *  (6) échec transitoire atteignant le seuil (attempts 3 → 4) → FAILED ;
 *  (7) reclaim des PROCESSING orphelins (crash) → repassés PENDING en début de tick.
 */

const { mockPrisma, mockProcess, mockSeal } = vi.hoisted(() => ({
  mockPrisma: {
    receiptExtractionOutbox: { updateMany: vi.fn(), findMany: vi.fn() },
  },
  mockProcess: vi.fn(),
  mockSeal: vi.fn(),
}))

vi.mock('../db', () => ({ prisma: mockPrisma }))
vi.mock('../services/visionClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/visionClient')>()
  return { ...actual, processReceiptImage: mockProcess }
})
// sealReceipt isolé : on vérifie qu'il est appelé après COMPLETED, pas sa logique.
vi.mock('../services/escrowService', () => ({ sealReceipt: mockSeal }))

import { processReceiptOutbox } from './receiptOutboxWorker'
import { VisionExtractionError, type VisionClient } from '../services/visionClient'
import { UnsupportedImageError } from '../services/inputGuard'

const fakeClient = {} as VisionClient

const RECEIPT = {
  id: 'rcpt_1',
  orderId: 'order_1',
  totalAmount: 1500,
  currency: 'EUR',
  merchantName: 'Shop',
  date: '2026-01-15T10:00:00.000Z',
  items: [{ name: 'Widget', price: 1500 }],
}

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'job_1',
  missionId: 'm1',
  uploaderId: 'u1',
  imageData: Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0xff, 0xd9]),
  mimeType: 'image/jpeg',
  status: 'PENDING',
  attempts: 0,
  lastError: null,
  resultJson: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
})

type Call = [{ where: Record<string, unknown>; data: Record<string, unknown> }]
const calls = (): Call[] => mockPrisma.receiptExtractionOutbox.updateMany.mock.calls as Call[]
const reclaimCalls = () =>
  calls().filter(([a]) => a.where.status === 'PROCESSING' && a.where.updatedAt !== undefined)
const claimCalls = () =>
  calls().filter(([a]) => a.where.status === 'PENDING' && a.data.status === 'PROCESSING')
const verdictCalls = () =>
  calls().filter(([a]) => a.where.status === 'PROCESSING' && a.where.updatedAt === undefined)

describe('processReceiptOutbox — worker extraction OCR de reçu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Tout updateMany réussit par défaut (reclaim, claim, verdict) ; surchargé au besoin.
    mockPrisma.receiptExtractionOutbox.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([])
    mockProcess.mockResolvedValue(RECEIPT)
    mockSeal.mockResolvedValue({ outcome: 'CONSUMED', receiptId: 'r1' })
  })

  it('(1) PENDING → claim PENDING→PROCESSING (attempts +1) puis COMPLETED + resultJson', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([job({ attempts: 0 })])

    await processReceiptOutbox(fakeClient)

    // File PENDING bornée.
    expect(mockPrisma.receiptExtractionOutbox.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
      take: 10,
    })
    // Claim conditionnel anti-TOCTOU : PENDING → PROCESSING, attempts incrémenté.
    expect(claimCalls()).toHaveLength(1)
    expect(claimCalls()[0][0]).toEqual({
      where: { id: 'job_1', status: 'PENDING' },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    })
    // Extraction réellement lancée avec un Buffer (image stockée).
    expect(mockProcess).toHaveBeenCalledTimes(1)
    expect(Buffer.isBuffer(mockProcess.mock.calls[0][0])).toBe(true)
    // Verdict COMPLETED conditionnel sur PROCESSING, snapshot du reçu, lastError purgé.
    expect(verdictCalls()).toHaveLength(1)
    expect(verdictCalls()[0][0]).toEqual({
      where: { id: 'job_1', status: 'PROCESSING' },
      data: { status: 'COMPLETED', resultJson: RECEIPT, lastError: null },
    })
    // Scellement déclenché APRÈS le passage COMPLETED.
    expect(mockSeal).toHaveBeenCalledWith('job_1')
  })

  it('(1-bis) échec d’extraction → AUCUN scellement', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([job({ attempts: 0 })])
    mockProcess.mockRejectedValueOnce(new VisionExtractionError('UNREADABLE_IMAGE'))

    await processReceiptOutbox(fakeClient)

    expect(mockSeal).not.toHaveBeenCalled()
  })

  it('(2) claim perdu (count=0) → AUCUNE extraction ni verdict', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([job()])
    // Le claim ne matche rien (ligne déjà réclamée ailleurs).
    mockPrisma.receiptExtractionOutbox.updateMany.mockImplementation(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.status === 'PENDING' && data.status === 'PROCESSING') return { count: 0 }
        return { count: 1 }
      },
    )

    await processReceiptOutbox(fakeClient)

    expect(mockProcess).not.toHaveBeenCalled()
    expect(verdictCalls()).toHaveLength(0)
  })

  it('(3) échec transitoire (UNREADABLE_IMAGE), attempts < max → ré-éligible (PENDING)', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([job({ attempts: 0 })])
    mockProcess.mockRejectedValueOnce(new VisionExtractionError('UNREADABLE_IMAGE'))

    await processReceiptOutbox(fakeClient)

    expect(verdictCalls()).toHaveLength(1)
    expect(verdictCalls()[0][0]).toEqual({
      where: { id: 'job_1', status: 'PROCESSING' },
      data: { status: 'PENDING', lastError: 'UNREADABLE_IMAGE' },
    })
  })

  it('(4) échec déterministe de contenu (SCHEMA_MISMATCH) → FAILED immédiat', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([job({ attempts: 0 })])
    mockProcess.mockRejectedValueOnce(new VisionExtractionError('SCHEMA_MISMATCH'))

    await processReceiptOutbox(fakeClient)

    expect(verdictCalls()[0][0].data).toMatchObject({ status: 'FAILED', lastError: 'SCHEMA_MISMATCH' })
  })

  it('(5) échec déterministe structurel (UnsupportedImageError) → FAILED immédiat', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([job({ attempts: 0 })])
    mockProcess.mockRejectedValueOnce(new UnsupportedImageError('magic bytes non JPEG/PNG'))

    await processReceiptOutbox(fakeClient)

    expect(verdictCalls()[0][0].data).toMatchObject({ status: 'FAILED' })
  })

  it('(6) échec transitoire atteignant le seuil (attempts 3 → 4) → FAILED', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([job({ attempts: 3 })])
    mockProcess.mockRejectedValueOnce(new VisionExtractionError('UNREADABLE_IMAGE'))

    await processReceiptOutbox(fakeClient)

    expect(verdictCalls()[0][0].data).toMatchObject({ status: 'FAILED' })
  })

  it('(7) reclaim des PROCESSING orphelins → repassés PENDING en tête de tick', async () => {
    mockPrisma.receiptExtractionOutbox.findMany.mockResolvedValue([])

    await processReceiptOutbox(fakeClient)

    // Un updateMany de reclaim : where status PROCESSING + updatedAt borné, data PENDING.
    expect(reclaimCalls()).toHaveLength(1)
    const [arg] = reclaimCalls()[0]
    expect(arg.where.status).toBe('PROCESSING')
    expect(arg.data).toEqual({ status: 'PENDING' })
    expect((arg.where.updatedAt as { lt: Date }).lt).toBeInstanceOf(Date)
  })
})
