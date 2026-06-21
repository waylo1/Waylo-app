import { prisma } from '../db'
import { Prisma } from '../generated/prisma'
import { processReceiptImage, VisionExtractionError, type VisionClient } from '../services/visionClient'
import { UnsupportedImageError, MalformedImageError } from '../services/inputGuard'

/**
 * Worker d'extraction OCR de reçu — draine `ReceiptExtractionOutbox`
 * (PENDING → PROCESSING → COMPLETED|FAILED) en réutilisant `processReceiptImage`.
 *
 * Pourquoi DEUX phases (et non l'unique $transaction des outbox monétaires) :
 * l'étape lourde est un appel réseau Vision. On ne tient JAMAIS une transaction
 * DB ouverte pendant un appel externe (verrou long, épuisement du pool). Donc :
 *   (1) CLAIM atomique PENDING → PROCESSING, attempts +1 — committé immédiatement ;
 *   (2) extraction Vision HORS transaction ;
 *   (3) verdict committé : PROCESSING → COMPLETED (resultJson) | FAILED | PENDING.
 *
 * Le claim conditionnel `where: { id, status: 'PENDING' }` est l'unique rempart
 * anti-TOCTOU multi-instance (count=0 ⇒ déjà pris ailleurs → on saute).
 *
 * Reprise après crash : un job laissé en PROCESSING (process mort en plein appel)
 * est ré-éligibilisé (→ PENDING) après STALE_PROCESSING_MS — aucun worker ne tient
 * légitimement un job aussi longtemps.
 */

const BATCH_SIZE = 10
// Au-delà de ce nombre de prises en charge, un échec NON déterministe (réseau/API)
// est classé définitif (FAILED) — borne les ré-essais et la dépense Vision.
const MAX_ATTEMPTS = 4
// Un job en PROCESSING plus vieux que ce délai est orphelin (crash) → repassé PENDING.
// DOIT excéder le pire temps d'un appel Vision (timeout SDK Anthropic ~10 min) : sinon
// un appel lent mais VIVANT serait ré-éligibilisé → double extraction (coût gaspillé ;
// pas de corruption — le verdict conditionnel `where status PROCESSING` reste l'arbitre).
const STALE_PROCESSING_MS = 15 * 60_000

/**
 * Vrai si l'erreur est DÉTERMINISTE : ré-essayer la même image ne changera rien.
 * Les gardes structurelles d'image (format non supporté / malformé) le sont ;
 * une `VisionExtractionError` de CONTENU (JSON/schéma/total) l'est de facto sur la
 * même image. `UNREADABLE_IMAGE` enveloppe en revanche un échec d'appel Vision
 * (réseau/API) potentiellement TRANSITOIRE → ré-essayable.
 */
function isDeterministicFailure(error: unknown): boolean {
  if (error instanceof UnsupportedImageError || error instanceof MalformedImageError) return true
  if (error instanceof VisionExtractionError) return error.code !== 'UNREADABLE_IMAGE'
  return false
}

export async function processReceiptOutbox(client: VisionClient): Promise<void> {
  // (0) Reprise des jobs PROCESSING orphelins (crash mid-appel) → ré-éligibles.
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS)
  await prisma.receiptExtractionOutbox.updateMany({
    where: { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
    data: { status: 'PENDING' },
  })

  const pendings = await prisma.receiptExtractionOutbox.findMany({
    where: { status: 'PENDING' },
    take: BATCH_SIZE,
  })

  for (const job of pendings) {
    // (1) Claim atomique anti-TOCTOU : PENDING → PROCESSING, attempts +1. Committé
    // AVANT l'appel Vision. count !== 1 ⇒ ligne déjà réclamée par un autre tick /
    // une autre instance → on saute (aucun double-traitement).
    const claim = await prisma.receiptExtractionOutbox.updateMany({
      where: { id: job.id, status: 'PENDING' },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    })
    if (claim.count !== 1) continue

    const attemptsNow = job.attempts + 1
    try {
      // (2) Extraction Vision (hors transaction). imageData déjà nettoyée à l'upload ;
      // processReceiptImage re-sanitize (idempotent) puis valide schéma + intégrité.
      const receipt = await processReceiptImage(Buffer.from(job.imageData), client)

      // (3a) Succès : PROCESSING → COMPLETED, snapshot du reçu extrait. Conditionnel
      // sur PROCESSING (défensif : un reclaim concurrent ne peut pas l'écraser).
      await prisma.receiptExtractionOutbox.updateMany({
        where: { id: job.id, status: 'PROCESSING' },
        data: {
          status: 'COMPLETED',
          resultJson: receipt as unknown as Prisma.InputJsonValue,
          lastError: null,
        },
      })
    } catch (error) {
      // (3b) Échec : définitif si erreur déterministe (image/contenu) OU seuil de
      // ré-essais atteint ; sinon ré-éligible (→ PENDING) pour le prochain tick.
      const message = error instanceof Error ? error.message : String(error)
      const terminal = isDeterministicFailure(error) || attemptsNow >= MAX_ATTEMPTS
      await prisma.receiptExtractionOutbox.updateMany({
        where: { id: job.id, status: 'PROCESSING' },
        data: { status: terminal ? 'FAILED' : 'PENDING', lastError: message },
      })
    }
  }
}

/**
 * Boucle cron explicite (~1 min) — miroir de `startBuyerCompensationWorkerLoop`.
 * Garde `inFlight` : un tick arrivant pendant un batch en cours est SAUTÉ (jamais
 * deux runs concurrents dans CE process). Le claim atomique reste le seul rempart
 * multi-instance. Le `.catch` de tick empêche qu'une exception de batch (ex. DB
 * injoignable au `findMany`) n'effondre le scheduler.
 */
export function startReceiptOutboxWorkerLoop(
  client: VisionClient,
  intervalMs = 60_000,
  log: { error(details: Record<string, unknown>, message?: string): void } = console,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return // run précédent encore en cours — tick sauté
    inFlight = true
    void processReceiptOutbox(client)
      .catch(err => log.error({ err: String(err) }, 'receipt outbox worker tick failed'))
      .finally(() => {
        inFlight = false
      })
  }, intervalMs)
}
