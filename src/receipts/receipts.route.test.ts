import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User, Mission } from '../generated/prisma'
import type { PaymentIntentClient } from '../missions/mission-common'
import type { VisionClient } from '../services/visionClient'
import { processReceiptOutbox } from '../workers/receiptOutboxWorker'

/**
 * POST /api/receipts/upload + worker d'extraction — chaîne complète (DB réelle waylo_test) :
 * (E2E-1) le voyageur dépose un reçu → 202 { outboxId }, ligne PENDING en base ;
 *         déclenchement manuel du worker (client Vision factice) → COMPLETED + resultJson ;
 * (E2E-2) extraction déterministe en échec (JSON invalide) → FAILED ;
 * (AUTHZ) non-voyageur → 404 ; non authentifié → 401 ;
 * (VALID) missionId manquant → 400 ; aucun fichier → 400 ; format non supporté → 415.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

// JPEG minimal valide pour sanitizeVisionInput : SOI (FF D8) + SOS (FF DA) — le
// nettoyeur copie verbatim à partir du SOS. ≥ 8 octets requis.
const MINIMAL_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x00, 0xff, 0xd9])
// Octets sans magic JPEG/PNG → UnsupportedImageError → 415.
const UNSUPPORTED_BYTES = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])

const RECEIPT_JSON = JSON.stringify({
  id: 'rcpt_e2e',
  orderId: 'order_e2e',
  totalAmount: 1500,
  currency: 'EUR',
  merchantName: 'E2E Shop',
  date: '2026-01-15T10:00:00.000Z',
  items: [{ name: 'Widget', price: 1500 }],
})

// Client Vision factice : renvoie un reçu cohérent (total = somme des lignes).
const okClient: VisionClient = { extractJson: async () => RECEIPT_JSON }
// Client renvoyant un JSON invalide → VisionExtractionError('INVALID_JSON') → FAILED déterministe.
const badClient: VisionClient = { extractJson: async () => 'not json {{{' }

const BOUNDARY = '----waylotestboundary7e21'

/** Corps multipart/form-data (Buffer) : champ missionId + 1 fichier binaire. */
function multipartBody(
  missionId: string | null,
  file: Buffer | null,
  filename = 'receipt.jpg',
  contentType = 'image/jpeg',
): Buffer {
  const chunks: Buffer[] = []
  if (missionId !== null) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="missionId"\r\n\r\n${missionId}\r\n`,
      ),
    )
  }
  if (file !== null) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
      file,
      Buffer.from('\r\n'),
    )
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

describe('POST /api/receipts/upload + worker', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let buyer: User
  let traveler: User
  let outsider: User
  let mission: Mission
  let travelerToken: string
  let outsiderToken: string

  const fakeStripe: PaymentIntentClient = {
    paymentIntents: {
      create: async (params) => ({
        id: `pi_rc_${params.metadata['missionId']}`,
        client_secret: 'secret',
      }),
      capture: async (id) => ({ id }),
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp({ stripe: fakeStripe })

    await prisma.receiptExtractionOutbox.deleteMany()
    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.issuingAuthorizationLog.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.user.deleteMany()

    buyer = await prisma.user.create({ data: { email: 'buyer-rc@test.waylo' } })
    traveler = await prisma.user.create({ data: { email: 'traveler-rc@test.waylo' } })
    outsider = await prisma.user.create({ data: { email: 'outsider-rc@test.waylo' } })
    mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'IN_PROGRESS',
        targetProduct: 'Article test',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Tokyo',
        // Montant d'achat déclaré = total du reçu OCR (1500) → scellement CONSUMED.
        purchaseAmountCents: 1500,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    travelerToken = app.jwt.sign({ sub: traveler.id })
    outsiderToken = app.jwt.sign({ sub: outsider.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const upload = (
    token: string | null,
    body: Buffer,
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/receipts/upload',
      headers: {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      payload: body,
    })

  it('(E2E-1) upload → PENDING → worker → extraction + scellement → CONSUMED + Receipt', async () => {
    const res = await upload(travelerToken, multipartBody(mission.id, MINIMAL_JPEG))

    expect(res.statusCode).toBe(202)
    const { outboxId } = res.json() as { outboxId: string }
    expect(outboxId).toEqual(expect.any(String))

    // Ligne PENDING persistée, image stockée, métadonnées correctes.
    const pending = await prisma.receiptExtractionOutbox.findUnique({ where: { id: outboxId } })
    expect(pending).toMatchObject({
      missionId: mission.id,
      uploaderId: traveler.id,
      status: 'PENDING',
      mimeType: 'image/jpeg',
      attempts: 0,
    })
    expect(pending?.imageData.length).toBeGreaterThan(0)

    // Déclenchement manuel du worker (client Vision factice cohérent).
    // total OCR (1500) === mission.purchaseAmountCents (1500) → validé + scellé.
    await processReceiptOutbox(okClient)

    const done = await prisma.receiptExtractionOutbox.findUnique({ where: { id: outboxId } })
    expect(done?.status).toBe('CONSUMED')
    expect(done?.attempts).toBe(1)
    expect(done?.lastError).toBeNull()
    expect(done?.resultJson).toMatchObject({ totalAmount: 1500, currency: 'EUR' })

    // Receipt scellé créé pour la mission (totalTtcCents = total OCR, sha256 posé).
    const sealed = await prisma.receipt.findUnique({ where: { missionId: mission.id } })
    expect(sealed).not.toBeNull()
    expect(sealed?.totalTtcCents).toBe(1500)
    expect(sealed?.sha256Server).toMatch(/^[0-9a-f]{64}$/)
  })

  it('(E2E-2) extraction déterministe en échec (JSON invalide) → FAILED', async () => {
    const res = await upload(travelerToken, multipartBody(mission.id, MINIMAL_JPEG))
    const { outboxId } = res.json() as { outboxId: string }

    await processReceiptOutbox(badClient)

    const failed = await prisma.receiptExtractionOutbox.findUnique({ where: { id: outboxId } })
    expect(failed?.status).toBe('FAILED')
    expect(failed?.lastError).toBe('INVALID_JSON')
  })

  it('(E2E-3 anti-fraude) total OCR ≠ purchaseAmountCents → FAILED, aucun Receipt', async () => {
    // Mission dont le montant déclaré (9999) diffère du total OCR (1500).
    const mismatchMission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        travelerId: traveler.id,
        status: 'IN_PROGRESS',
        targetProduct: 'Article mismatch',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Osaka',
        purchaseAmountCents: 9999,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })

    const res = await upload(travelerToken, multipartBody(mismatchMission.id, MINIMAL_JPEG))
    const { outboxId } = res.json() as { outboxId: string }

    await processReceiptOutbox(okClient) // total OCR 1500 ≠ 9999 → blocage

    const blocked = await prisma.receiptExtractionOutbox.findUnique({ where: { id: outboxId } })
    expect(blocked?.status).toBe('FAILED')
    expect(blocked?.lastError).toBe('PRICE_MISMATCH')
    // Aucun reçu scellé : la fraude présumée n'entre jamais dans l'état canonique.
    const noReceipt = await prisma.receipt.findUnique({ where: { missionId: mismatchMission.id } })
    expect(noReceipt).toBeNull()
  })

  it('(AUTHZ) un non-voyageur de la mission → 404 MISSION_NOT_FOUND', async () => {
    const res = await upload(outsiderToken, multipartBody(mission.id, MINIMAL_JPEG))
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
  })

  it('(AUTHZ) non authentifié → 401', async () => {
    const res = await upload(null, multipartBody(mission.id, MINIMAL_JPEG))
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' })
  })

  it('(VALID) missionId manquant → 400 INVALID_INPUT', async () => {
    const res = await upload(travelerToken, multipartBody(null, MINIMAL_JPEG))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  it('(VALID) aucun fichier → 400 NO_FILE', async () => {
    const res = await upload(travelerToken, multipartBody(mission.id, null))
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'NO_FILE' })
  })

  it('(VALID) format non supporté → 415 UNSUPPORTED_IMAGE', async () => {
    const res = await upload(travelerToken, multipartBody(mission.id, UNSUPPORTED_BYTES, 'x.bin', 'application/octet-stream'))
    expect(res.statusCode).toBe(415)
    expect(res.json()).toEqual({ error: 'UNSUPPORTED_IMAGE' })
  })
})
