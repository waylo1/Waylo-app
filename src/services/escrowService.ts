import { createHash, timingSafeEqual } from 'node:crypto'
import { prisma } from '../db'
import { MissionStatus, OutboxEventType } from '../generated/prisma'
import { isUniqueViolation } from '../missions/mission-common'
import { hashQrCode } from '../missions/qr-proof'

// Point d'import unique pour le worker escrowPayoutWorker — évite deux sources
// d'import vers escrow.service.ts et escrowService.ts dans le même fichier.
export { captureEscrowFunds, EscrowCaptureError, type CaptureEscrowResult } from './escrow.service'

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

// ─────────────────── confirmReception (acheteur) ───────────────────

/** Preuve de livraison absente ou non vérifiée — la confirmation est refusée. */
export class DeliveryProofError extends Error {
  constructor(readonly code: 'DELIVERY_PROOF_MISSING' | 'DELIVERY_PROOF_INVALID') {
    super(code)
    this.name = 'DeliveryProofError'
  }
}

/** Précondition de confirmation non satisfaite (mission absente / mauvais état / non-acheteur). */
export class ReceptionConflictError extends Error {
  constructor(
    readonly code: 'MISSION_NOT_FOUND' | 'MISSION_NOT_AWAITING_CONFIRMATION' | 'NOT_MISSION_BUYER',
  ) {
    super(code)
    this.name = 'ReceptionConflictError'
  }
}

export interface ConfirmReceptionResult {
  missionId: string
  status: 'COMPLETED_BY_BUYER'
  /** Id de l'OutboxEvent READY_FOR_PAYOUT à consommer par le worker de paiement. */
  outboxEventId: string
}

/** Comparaison en temps constant de deux chaînes (anti oracle de timing). */
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Confirmation de réception par l'ACHETEUR — porte d'entrée du paiement voyageur.
 *
 * UNE seule `prisma.$transaction`, 100% écriture DB (règle « No Stripe in DB tx ») :
 *   1. Validation STRICTE de `deliveryProof` (présent + vérifié) AVANT toute écriture
 *      monétaire — sinon rollback total (aucun effet).
 *   2. Autorisation par ressource : seul l'acheteur de la mission peut confirmer.
 *   3. Transition conditionnelle AWAITING_CONFIRMATION → COMPLETED_BY_BUYER (anti-TOCTOU)
 *      + scellement du hash de preuve (preuve irréfutable de litige).
 *   4. Handoff paiement : OutboxEvent READY_FOR_PAYOUT (PENDING) — la capture Stripe
 *      réelle est exécutée HORS transaction par le worker consommateur.
 *   5. Audit append-only (AdminAuditLog), sans aucun calcul de seuil douanier.
 *
 * Vérification de la preuve : si la mission porte un code consigne
 * (`dropOffAccessCode`), `deliveryProof` DOIT le matcher (temps constant). Sinon,
 * une saisie non vide suffit (« saisie validée ») — seam d'une future vérification
 * via API transporteur. Le secret n'est jamais persisté en clair : seul son sha256.
 */
export async function confirmReception(
  missionId: string,
  actorId: string,
  deliveryProof: string,
): Promise<ConfirmReceptionResult> {
  // (1) Validation stricte de présence AVANT d'ouvrir la transaction.
  if (typeof deliveryProof !== 'string' || deliveryProof.trim().length === 0) {
    throw new DeliveryProofError('DELIVERY_PROOF_MISSING')
  }

  return prisma.$transaction(async (tx): Promise<ConfirmReceptionResult> => {
    const mission = await tx.mission.findUnique({
      where: { id: missionId },
      select: { id: true, status: true, buyerId: true, dropOffAccessCode: true },
    })
    if (!mission) throw new ReceptionConflictError('MISSION_NOT_FOUND')
    // (2) Autorisation par ressource : seul l'acheteur confirme la réception.
    if (mission.buyerId !== actorId) throw new ReceptionConflictError('NOT_MISSION_BUYER')
    if (mission.status !== MissionStatus.AWAITING_CONFIRMATION) {
      throw new ReceptionConflictError('MISSION_NOT_AWAITING_CONFIRMATION')
    }

    // Vérification de la preuve : match du code consigne si présent, sinon saisie validée.
    if (mission.dropOffAccessCode !== null) {
      if (!constantTimeEquals(deliveryProof, mission.dropOffAccessCode)) {
        throw new DeliveryProofError('DELIVERY_PROOF_INVALID') // → rollback total
      }
    }

    const deliveryProofHash = hashQrCode(deliveryProof) // sha256 hex — jamais le secret en clair

    // (3) Transition conditionnelle anti-TOCTOU + scellement de la preuve.
    const updated = await tx.mission.updateMany({
      where: { id: missionId, status: MissionStatus.AWAITING_CONFIRMATION },
      data: {
        status: MissionStatus.COMPLETED_BY_BUYER,
        deliveryProofHash,
        receptionConfirmedAt: new Date(),
      },
    })
    if (updated.count !== 1) throw new ReceptionConflictError('MISSION_NOT_AWAITING_CONFIRMATION')

    // (4) Handoff paiement (capture déléguée au worker, hors tx).
    const event = await tx.outboxEvent.create({
      data: {
        missionId,
        type: OutboxEventType.READY_FOR_PAYOUT,
        payload: { deliveryProofHash, confirmedBy: actorId },
      },
      select: { id: true },
    })

    // (5) Audit append-only (historique mission) — aucun calcul de seuil.
    await tx.adminAuditLog.create({
      data: { adminId: actorId, action: 'CONFIRM_RECEPTION', missionId },
    })

    return { missionId, status: 'COMPLETED_BY_BUYER', outboxEventId: event.id }
  })
}
