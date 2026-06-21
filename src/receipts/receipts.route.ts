import { FastifyError, FastifyPluginAsync } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import { prisma } from '../db'
import {
  sanitizeVisionInput,
  UnsupportedImageError,
  MalformedImageError,
} from '../services/inputGuard'

/**
 * API d'upload de reçu — POST /api/receipts/upload (multipart).
 *
 * Chemin : multipart (1 fichier + champ `missionId`) → garde d'autorisation
 * (voyageur de la mission, anti-IDOR) → `sanitizeVisionInput` (fail-closed,
 * métadonnées retirées AVANT persistance) → insertion `ReceiptExtractionOutbox`
 * (PENDING) → 202 { outboxId }. L'extraction OCR elle-même est asynchrone
 * (worker `receiptOutboxWorker`) : la route ne fait JAMAIS d'appel Vision.
 *
 * Mapping des erreurs :
 *   manque le champ missionId      → 400 INVALID_INPUT
 *   aucun fichier / fichier vide   → 400 NO_FILE
 *   fichier > MAX_FILE_BYTES       → 413 FILE_TOO_LARGE (@fastify/multipart)
 *   format non JPEG/PNG            → 415 UNSUPPORTED_IMAGE
 *   image structurellement invalide→ 400 MALFORMED_IMAGE
 *   mission absente / non-voyageur  → 404 MISSION_NOT_FOUND (existence jamais révélée)
 */

// Borne anti-DoS de la taille d'upload (8 Mo) : au-delà, l'API Vision rejette de
// toute façon, et on refuse de stocker un blob arbitraire en base.
const MAX_FILE_BYTES = 8 * 1024 * 1024

/**
 * MIME d'après les magic bytes. Après `sanitizeVisionInput`, le format est
 * garanti JPEG ou PNG → PNG est le repli (miroir de `detectMimeType` côté worker).
 */
function detectMimeType(buf: Buffer): 'image/jpeg' | 'image/png' {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  return 'image/png'
}

const receiptsRoute: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const code = (err as { code?: string }).code
    // Dépassement de la limite de taille multipart → 413 (et non 500).
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: 'FILE_TOO_LARGE' })
    }
    // Trop de fichiers / de parts (au-delà de `files: 1`) : entrée invalide → 400.
    if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
      return reply.code(400).send({ error: 'INVALID_INPUT' })
    }
    if (err.validation) return reply.code(400).send({ error: 'INVALID_INPUT' })
    req.log.error({ err }, 'receipts route error')
    return reply.code(500).send({ error: 'INTERNAL_ERROR' })
  })

  // Parser multipart encapsulé à ce plugin : un seul fichier, taille bornée.
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_FILE_BYTES, files: 1 } })

  // Auth en onRequest (AVANT le parsing du corps) : un non-authentifié reçoit 401.
  app.addHook('onRequest', app.authenticate)

  app.post('/upload', async (req, reply) => {
    let imageBuffer: Buffer | undefined
    let missionId: string | undefined

    // Itération sur les parts : robuste à l'ordre fichier/champ. `toBuffer()`
    // lève FST_REQ_FILE_TOO_LARGE au-delà de la limite → capté par l'errorHandler.
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        imageBuffer = await part.toBuffer()
      } else if (part.fieldname === 'missionId' && typeof part.value === 'string') {
        missionId = part.value
      }
    }

    if (!missionId) return reply.code(400).send({ error: 'INVALID_INPUT' })
    if (!imageBuffer || imageBuffer.length === 0) return reply.code(400).send({ error: 'NO_FILE' })

    // Autorisation PAR RESSOURCE (anti-IDOR) : seul le VOYAGEUR de la mission peut
    // déposer le reçu d'achat. 404 si la mission n'existe pas OU si l'appelant n'en
    // est pas le voyageur — les deux cas indistinguables (l'existence n'est jamais
    // révélée à un tiers).
    const mission = await prisma.mission.findFirst({
      where: { id: missionId, travelerId: req.user.sub },
      select: { id: true },
    })
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

    // Nettoyage métadonnées AVANT persistance (fail-closed) : un format non supporté
    // ou une image malformée est rejetée À L'UPLOAD — jamais mise en file.
    let clean: Buffer
    try {
      clean = await sanitizeVisionInput(imageBuffer)
    } catch (err) {
      if (err instanceof UnsupportedImageError) {
        return reply.code(415).send({ error: 'UNSUPPORTED_IMAGE' })
      }
      if (err instanceof MalformedImageError) {
        return reply.code(400).send({ error: 'MALFORMED_IMAGE' })
      }
      throw err
    }

    const job = await prisma.receiptExtractionOutbox.create({
      data: {
        missionId,
        uploaderId: req.user.sub,
        imageData: clean,
        mimeType: detectMimeType(clean),
      },
      select: { id: true },
    })

    return reply.code(202).send({ outboxId: job.id })
  })
}

export default receiptsRoute
