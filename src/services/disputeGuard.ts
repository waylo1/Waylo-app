import type { PrismaClient } from '../generated/prisma'
import { EscrowStatus } from '../generated/prisma'
import type { Receipt, Order } from '../types/receipt'
import {
  IntegrityViolation,
  reconcileExtractedReceipt,
  verifyReceiptIntegrity,
  type IntegrityViolationReason,
} from './receiptReconciliation'
import { createDisputeInTx, openDisputeInTx } from './dispute.service'
import { safeEmit, type AlertSink } from '../alerts'

/**
 * disputeGuard — pont entre le contrôle d'intégrité d'un reçu (verifyReceiptIntegrity /
 * reconcileExtractedReceipt) et l'état financier de la mission, juste AVANT toute
 * libération de séquestre.
 *
 * Principe (miroir MISSION_DISPUTED_BY_BUYER) : un reçu incohérent ou un texte OCR
 * adverse ne DÉBLOQUE jamais les fonds. À la place, la mission est GELÉE par
 * ouverture d'un litige (DRAFT → OPEN), ce qui la retire des workers d'exécution
 * automatique (capture/refund) et impose un arbitrage humain. L'escrow lui-même
 * n'est JAMAIS muté ici (cohérent avec escrow-guard : immutabilité préservée) —
 * il reste HELD ; c'est le litige qui bloque, pas une transition d'escrow.
 *
 * I/O assumé : ce garde ÉCRIT (litige) et émet une alerte — il n'est PAS pur, à la
 * différence de verifyReceiptIntegrity. Il opère sur un client tx-aware injecté
 * (à appeler DANS un prisma.$transaction par la route appelante) et un sink
 * d'alerte injectable → unit-testable sans DB ni réseau.
 */

/** Surface minimale d'écriture de litige — compatible PrismaClient et client de transaction. */
type DisputeWriter = Pick<PrismaClient['dispute'], 'upsert' | 'updateMany'>

export interface ReceiptGuardInput {
  missionId: string
  /** Initiateur du litige automatique (système ou acheteur). */
  actorId: string
  receipt: Receipt
  order: Order
  /** Statut courant du séquestre — seul HELD est « guardable » (libérable). */
  escrowStatus: EscrowStatus
  /**
   * Texte OCR brut. Fourni → pipeline complet (anti-injection PUIS intégrité).
   * Absent → contrôle d'intégrité seul (reçu déjà structuré et de confiance).
   */
  ocrText?: string
  /** Client Prisma tx-aware (transaction de la route appelante). */
  client: { dispute: DisputeWriter }
  /** Sink d'alerte injectable (défaut : canal prod). */
  alertSink?: AlertSink
  /** Motif consigné sur le litige (défaut dérivé de la raison de violation). */
  reason?: string
}

/**
 * Décision du garde :
 * - RELEASE_ALLOWED : escrow HELD + intégrité OK → la route peut libérer.
 * - FROZEN          : violation d'intégrité → litige ouvert, fonds gelés.
 * - NOT_GUARDABLE   : escrow déjà hors HELD → rien à gater (décision antérieure).
 */
export type ReceiptGuardResult =
  | { decision: 'RELEASE_ALLOWED' }
  | { decision: 'FROZEN'; reason: IntegrityViolationReason }
  | { decision: 'NOT_GUARDABLE'; escrowStatus: EscrowStatus }

/**
 * Évalue l'intégrité d'un reçu et lie le verdict à l'état du séquestre.
 *
 * En cas de violation, GÈLE la mission (createDisputeInTx → openDisputeInTx) et
 * émet une alerte critique RECEIPT_INTEGRITY_VIOLATION ; ne libère jamais.
 * Renvoie une décision explicite — l'appelant ne libère que sur RELEASE_ALLOWED.
 */
export async function guardReceiptForRelease(
  input: ReceiptGuardInput,
): Promise<ReceiptGuardResult> {
  // L'escrow doit être libérable. Hors HELD (terminal ou en transit), la décision
  // de libération a déjà été prise ailleurs : ce garde n'a rien à gater et ne gèle
  // pas (cohérent avec escrow-guard, qui rejette toute mutation d'escrow terminal).
  if (input.escrowStatus !== EscrowStatus.HELD) {
    return { decision: 'NOT_GUARDABLE', escrowStatus: input.escrowStatus }
  }

  try {
    if (input.ocrText !== undefined) {
      reconcileExtractedReceipt(input.ocrText, input.receipt, input.order)
    } else {
      verifyReceiptIntegrity(input.receipt, input.order)
    }
    return { decision: 'RELEASE_ALLOWED' }
  } catch (err) {
    if (!(err instanceof IntegrityViolation)) throw err

    // GEL : ouvre (ou réutilise, idempotent) un litige et le passe DRAFT → OPEN.
    const reason = input.reason ?? `receipt_integrity:${err.reason}`
    await createDisputeInTx(input.client, input.missionId, input.actorId, reason)
    await openDisputeInTx(input.client, input.missionId)

    // Alerte critique : argent NON libéré mais mission gelée → arbitrage humain.
    safeEmit(input.alertSink, {
      code: 'RECEIPT_INTEGRITY_VIOLATION',
      message: `Intégrité reçu violée (${err.reason}) — mission ${input.missionId} gelée`,
      details: {
        missionId: input.missionId,
        reason: err.reason,
        expected: err.expected,
        actual: err.actual,
      },
    })

    return { decision: 'FROZEN', reason: err.reason }
  }
}
