import Anthropic from '@anthropic-ai/sdk'
import { receiptSchema } from '../schemas/receipt'
import type { Receipt } from '../types/receipt'
import { sanitizeVisionInput } from './inputGuard'
import { verifyReceiptIntegrity } from './receiptReconciliation'

export type VisionExtractionErrorCode =
  | 'UNREADABLE_IMAGE'
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH'
  | 'TOTAL_MISMATCH'

export class VisionExtractionError extends Error {
  constructor(
    readonly code: VisionExtractionErrorCode,
    readonly cause?: unknown,
  ) {
    super(code)
    this.name = 'VisionExtractionError'
  }
}

export interface VisionClient {
  extractJson(
    imageBuffer: Buffer,
    mimeType: 'image/jpeg' | 'image/png',
    systemPrompt: string,
  ): Promise<string>
}

const SYSTEM_PROMPT =
  'You are a strict JSON extractor. Respond only with JSON matching the receiptSchema. No markdown, no chat.'

function detectMimeType(buf: Buffer): 'image/jpeg' | 'image/png' {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  // sanitizeVisionInput guarantees JPEG or PNG — PNG is the fallback
  return 'image/png'
}

export async function processReceiptImage(
  imageBuffer: Buffer,
  client: VisionClient,
): Promise<Receipt> {
  // Step 1: sanitize — fail-closed, UnsupportedImageError/MalformedImageError propagate
  const clean = await sanitizeVisionInput(imageBuffer)

  // Step 2: detect MIME type (guaranteed JPEG or PNG after sanitization)
  const mimeType = detectMimeType(clean)

  // Step 3: call vision API
  let rawJson: string
  try {
    rawJson = await client.extractJson(clean, mimeType, SYSTEM_PROMPT)
  } catch (err) {
    throw new VisionExtractionError('UNREADABLE_IMAGE', err)
  }

  // Step 4: parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    throw new VisionExtractionError('INVALID_JSON', err)
  }

  // Step 5: validate schema (Zod at the boundary)
  const result = receiptSchema.safeParse(parsed)
  if (!result.success) {
    throw new VisionExtractionError('SCHEMA_MISMATCH', result.error)
  }
  const receipt = result.data as Receipt

  // Step 6: verify arithmetic consistency — self-order: ORDER_MISMATCH/CURRENCY_MISMATCH
  // can never fire; only TOTAL_MISMATCH catches hallucinated totals
  try {
    verifyReceiptIntegrity(receipt, { id: receipt.orderId, currency: receipt.currency })
  } catch (err) {
    throw new VisionExtractionError('TOTAL_MISMATCH', err)
  }

  return receipt
}

export class AnthropicVisionClient implements VisionClient {
  private readonly anthropic: Anthropic

  constructor(apiKey?: string) {
    this.anthropic = new Anthropic({ apiKey })
  }

  async extractJson(
    imageBuffer: Buffer,
    mimeType: 'image/jpeg' | 'image/png',
    systemPrompt: string,
  ): Promise<string> {
    const response = await this.anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: imageBuffer.toString('base64'),
              },
            },
            { type: 'text', text: 'Extract all receipt data as JSON.' },
          ],
        },
      ],
    })

    for (const block of response.content) {
      if (block.type === 'text') return block.text
    }
    throw new Error('No text response from vision API')
  }
}
