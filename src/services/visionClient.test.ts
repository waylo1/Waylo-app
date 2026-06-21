import { describe, expect, it, vi } from 'vitest'
import type { Receipt } from '../types/receipt'
import { UnsupportedImageError } from './inputGuard'
import { processReceiptImage, VisionExtractionError, type VisionClient } from './visionClient'

/**
 * Minimal JPEG that passes sanitizeVisionInput:
 * SOI (FF D8) + SOS marker (FF DA) — the sanitizer copies everything from SOS onward
 * verbatim, so the rest is treated as scan data. Total ≥ 8 bytes required.
 */
function makeMinimalJpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0xff, 0xd9])
}

/**
 * Minimal PNG that passes sanitizeVisionInput:
 * 8-byte signature + minimal IHDR chunk (13-byte data, fake CRC not validated)
 * + IEND chunk. Total 45 bytes.
 */
function makeMinimalPng(): Buffer {
  return Buffer.from([
    // PNG signature
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    // IHDR: length=13
    0x00, 0x00, 0x00, 0x0d,
    // chunk type 'IHDR'
    0x49, 0x48, 0x44, 0x52,
    // data: 1×1 px, 8-bit RGB
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
    // fake CRC (not validated by sanitizer)
    0xde, 0xad, 0xbe, 0xef,
    // IEND: length=0
    0x00, 0x00, 0x00, 0x00,
    // chunk type 'IEND'
    0x49, 0x45, 0x4e, 0x44,
    // canonical IEND CRC
    0xae, 0x42, 0x60, 0x82,
  ])
}

const VALID_RECEIPT: Receipt = {
  id: 'rcpt-1',
  orderId: 'order-1',
  totalAmount: 1500,
  currency: 'EUR',
  merchantName: 'Test Shop',
  date: '2024-01-15T10:00:00.000Z',
  items: [{ name: 'Widget', price: 1500 }],
}

describe('processReceiptImage', () => {
  it('returns Receipt on nominal JPEG path (detectMimeType JPEG branch)', async () => {
    const extractJson = vi.fn().mockResolvedValue(JSON.stringify(VALID_RECEIPT))
    const client = { extractJson } as unknown as VisionClient

    const result = await processReceiptImage(makeMinimalJpeg(), client)

    expect(result).toMatchObject({ orderId: 'order-1', totalAmount: 1500, currency: 'EUR' })
    expect(extractJson).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/jpeg',
      expect.stringContaining('JSON extractor'),
    )
  })

  it('returns Receipt on nominal PNG path (detectMimeType PNG branch)', async () => {
    const extractJson = vi.fn().mockResolvedValue(JSON.stringify(VALID_RECEIPT))
    const client = { extractJson } as unknown as VisionClient

    const result = await processReceiptImage(makeMinimalPng(), client)

    expect(result).toMatchObject({ orderId: 'order-1', totalAmount: 1500 })
    expect(extractJson).toHaveBeenCalledWith(expect.any(Buffer), 'image/png', expect.any(String))
  })

  it('throws UNREADABLE_IMAGE when extractJson rejects', async () => {
    const extractJson = vi.fn().mockRejectedValue(new Error('API unavailable'))
    const client = { extractJson } as unknown as VisionClient

    await expect(processReceiptImage(makeMinimalJpeg(), client)).rejects.toSatisfy(
      (e: unknown) => e instanceof VisionExtractionError && e.code === 'UNREADABLE_IMAGE',
    )
  })

  it('throws INVALID_JSON when response is not valid JSON', async () => {
    const extractJson = vi.fn().mockResolvedValue('not { valid } json }{{}')
    const client = { extractJson } as unknown as VisionClient

    await expect(processReceiptImage(makeMinimalJpeg(), client)).rejects.toSatisfy(
      (e: unknown) => e instanceof VisionExtractionError && e.code === 'INVALID_JSON',
    )
  })

  it('throws SCHEMA_MISMATCH when JSON does not match receiptSchema', async () => {
    const extractJson = vi.fn().mockResolvedValue(JSON.stringify({ foo: 'bar', baz: 42 }))
    const client = { extractJson } as unknown as VisionClient

    await expect(processReceiptImage(makeMinimalJpeg(), client)).rejects.toSatisfy(
      (e: unknown) => e instanceof VisionExtractionError && e.code === 'SCHEMA_MISMATCH',
    )
  })

  it('throws TOTAL_MISMATCH when hallucinated totalAmount differs from items sum', async () => {
    // items sum = 1500, but hallucinated total = 9999
    const hallucinated = { ...VALID_RECEIPT, totalAmount: 9999 }
    const extractJson = vi.fn().mockResolvedValue(JSON.stringify(hallucinated))
    const client = { extractJson } as unknown as VisionClient

    await expect(processReceiptImage(makeMinimalJpeg(), client)).rejects.toSatisfy(
      (e: unknown) => e instanceof VisionExtractionError && e.code === 'TOTAL_MISMATCH',
    )
  })

  it('propagates UnsupportedImageError from sanitizeVisionInput without calling extractJson', async () => {
    // Unknown format (not JPEG/PNG magic bytes) → sanitizeVisionInput throws UnsupportedImageError
    const unknownFmt = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    const extractJson = vi.fn()
    const client = { extractJson } as unknown as VisionClient

    await expect(processReceiptImage(unknownFmt, client)).rejects.toBeInstanceOf(
      UnsupportedImageError,
    )
    expect(extractJson).not.toHaveBeenCalled()
  })
})
