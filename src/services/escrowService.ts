import { createHash } from 'node:crypto'
import { prisma } from '../db'
import { isUniqueViolation } from '../missions/mission-common'

/**
 * escrowService — validation MÉTIER + scellement d'un reçu extrait par OCR.
 *
 * `sealReceipt(outboxId)` est appelé par le worker APRÈS une extraction réussie
 * (job en statut COMPLETED). Il porte la règle anti-fraude :
 *
 *   1. Charger le job (COMPLETED) + sa mission, DANS la transaction (lecture
 *      fraîche de `purchaseAmountCents` au moment du scellement — pas de TOCTOU).
 *   2. Comparaison STRICTE : `mission.purchaseAmountCents === resultJson.totalAmount`
 *      (centimes Int). `purchaseAmountCents` null OU écart ⇒ FAILED (blocage).
 *   3. Un reçu déjà scellé pour la mission (Receipt.missionId @unique — chemin
 *      manuel /submit-receipt ou OCR concurrent) ⇒ FAILED, JAMAIS d'écrasement
 *      (un reçu scellé est immuable).
 *   4. Sinon : création du Receipt scellé (sha256 de l'image) + outbox → CONSUMED,
 *      ATOMIQUEMENT (une seule $transaction).
 *
 * Ne touche NI l'escrow NI le statut de la mission : responsabilité unique =
 * valider+sceller le reçu. La capture/libération reste portée par ses chemins
 * dédiés (escrow.service / webhook).
 */

export type SealFailureReason =
  | 'PURCHASE_AMOUNT_MISSING'
  | 'PRICE_MISMATCH'
  | 'RECEIPT_ALREADY_SEALED'

export type SealReceiptOutcome =
  | { outcome: 'CONSUMED'; receiptId: string }
  | { outcome: 'FAILED'; reason: SealFailureReason }
  // Job introuvable ou déjà sorti de COMPLETED (idempotence) : aucun effet.
  | { outcome: 'SKIPPED'; reason: 'JOB_NOT_FOUND' | 'NOT_COMPLETED' }

/** Total OCR (centimes Int) extrait du snapshot resultJson, ou null si absent/malformé. */
function extractOcrTotal(resultJson: unknown): number | null {
  if (resultJson === null || typeof resultJson !== 'object') return null
  const total = (resultJson as { totalAmount?: unknown }).totalAmount
  return typeof total === 'number' && Number.isInteger(total) ? total : null
}

export async function sealReceipt(outboxId: string): Promise<SealReceiptOutcome> {
  try {
    return await prisma.$transaction(async (tx): Promise<SealReceiptOutcome> => {
      const job = await tx.receiptExtractionOutbox.findUnique({
        where: { id: outboxId },
        select: {
          status: true,
          imageData: true,
          resultJson: true,
          mission: { select: { id: true, purchaseAmountCents: true } },
        },
      })
      if (!job) return { outcome: 'SKIPPED', reason: 'JOB_NOT_FOUND' }
      // Idempotence : on ne scelle QUE depuis COMPLETED (jamais re-sceller un
      // CONSUMED/FAILED, ni un job encore en vol).
      if (job.status !== 'COMPLETED') return { outcome: 'SKIPPED', reason: 'NOT_COMPLETED' }

      const ocrTotal = extractOcrTotal(job.resultJson)
      const declared = job.mission.purchaseAmountCents

      // Anti-fraude — blocage : montant déclaré absent OU écart strict avec l'OCR.
      if (declared === null) {
        await tx.receiptExtractionOutbox.updateMany({
          where: { id: outboxId, status: 'COMPLETED' },
          data: { status: 'FAILED', lastError: 'PURCHASE_AMOUNT_MISSING' },
        })
        return { outcome: 'FAILED', reason: 'PURCHASE_AMOUNT_MISSING' }
      }
      if (ocrTotal === null || ocrTotal !== declared) {
        await tx.receiptExtractionOutbox.updateMany({
          where: { id: outboxId, status: 'COMPLETED' },
          data: { status: 'FAILED', lastError: 'PRICE_MISMATCH' },
        })
        return { outcome: 'FAILED', reason: 'PRICE_MISMATCH' }
      }

      // Immutabilité : un Receipt déjà scellé pour la mission n'est jamais écrasé.
      const existing = await tx.receipt.findUnique({
        where: { missionId: job.mission.id },
        select: { id: true },
      })
      if (existing) {
        await tx.receiptExtractionOutbox.updateMany({
          where: { id: outboxId, status: 'COMPLETED' },
          data: { status: 'FAILED', lastError: 'RECEIPT_ALREADY_SEALED' },
        })
        return { outcome: 'FAILED', reason: 'RECEIPT_ALREADY_SEALED' }
      }

      // Match : scellement. sha256 du contenu image (reçu scellé = preuve immuable).
      const sha256Server = createHash('sha256').update(job.imageData).digest('hex')
      const receipt = await tx.receipt.create({
        data: {
          missionId: job.mission.id,
          totalTtcCents: ocrTotal,
          sha256Client: sha256Server, // pas de hash client dans le flux OCR : sceau serveur seul
          sha256Server,
          sealedAt: new Date(),
        },
        select: { id: true },
      })
      // Transition conditionnelle COMPLETED → CONSUMED (anti double-scellement).
      const claimed = await tx.receiptExtractionOutbox.updateMany({
        where: { id: outboxId, status: 'COMPLETED' },
        data: { status: 'CONSUMED' },
      })
      if (claimed.count !== 1) {
        // Le job a quitté COMPLETED en concurrence : annuler (rollback du Receipt).
        throw new Error('SEAL_RACE')
      }
      return { outcome: 'CONSUMED', receiptId: receipt.id }
    })
  } catch (err) {
    // Course de scellement : un Receipt a été créé en parallèle (unicité missionId).
    // La transaction a été annulée → on bascule le job FAILED hors tx (jamais d'écrasement).
    if (isUniqueViolation(err)) {
      await prisma.receiptExtractionOutbox.updateMany({
        where: { id: outboxId, status: 'COMPLETED' },
        data: { status: 'FAILED', lastError: 'RECEIPT_ALREADY_SEALED' },
      })
      return { outcome: 'FAILED', reason: 'RECEIPT_ALREADY_SEALED' }
    }
    throw err
  }
}
