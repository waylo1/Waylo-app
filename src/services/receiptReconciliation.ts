import type { Receipt, Order } from '../types/receipt'
import { detectPromptInjection } from './inputGuard'

/**
 * Codes de violation d'intégrité (enum de raisons). SNAKE_CASE, miroir des
 * conventions d'erreur projet. `MANIPULATION_DETECTED` couvre une entrée OCR
 * adverse (injection de prompt / falsification) repérée AVANT la réconciliation.
 */
export type IntegrityViolationReason =
  | 'ORDER_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'TOTAL_MISMATCH'
  | 'MANIPULATION_DETECTED'

export class IntegrityViolation extends Error {
  constructor(
    readonly reason: IntegrityViolationReason,
    readonly expected?: unknown,
    readonly actual?: unknown,
  ) {
    super(reason)
    this.name = 'IntegrityViolation'
  }
}

/**
 * Vérifie la cohérence d'un reçu par rapport à la commande associée.
 * Fonction PURE, synchrone, zéro I/O (contrat verrouillé — ne pas y ajouter d'effet).
 * Toutes les comparaisons de montants sont en centimes (Int) — aucune tolérance flottante.
 */
export function verifyReceiptIntegrity(receipt: Receipt, order: Order): void {
  if (receipt.orderId !== order.id) {
    throw new IntegrityViolation('ORDER_MISMATCH', order.id, receipt.orderId)
  }

  if (receipt.currency !== order.currency) {
    throw new IntegrityViolation('CURRENCY_MISMATCH', order.currency, receipt.currency)
  }

  const itemsTotal = receipt.items.reduce((sum, item) => sum + item.price, 0)
  if (itemsTotal !== receipt.totalAmount) {
    throw new IntegrityViolation('TOTAL_MISMATCH', receipt.totalAmount, itemsTotal)
  }
}

/**
 * Pipeline de réconciliation d'un reçu EXTRAIT PAR OCR.
 *
 * Ordre imposé (défense en profondeur) :
 *   1. detectPromptInjection(ocrText) sur le TEXTE BRUT extrait — AVANT toute
 *      réconciliation. Une entrée adverse lève IntegrityViolation('MANIPULATION_DETECTED')
 *      et court-circuite : on ne réconcilie JAMAIS un reçu dont le texte source
 *      est suspect (le `receipt` structuré peut déjà être empoisonné).
 *   2. verifyReceiptIntegrity(receipt, order) — cohérence arithmétique/identité.
 *
 * `verifyReceiptIntegrity` reste pur : c'est CE point d'entrée, et non lui, qui
 * porte le branchement OCR (le contrôle d'injection n'a de sens que sur le texte
 * source, pas sur la structure déjà parsée).
 *
 * Fonction pure, synchrone, zéro I/O.
 */
export function reconcileExtractedReceipt(
  ocrText: string,
  receipt: Receipt,
  order: Order,
): void {
  if (detectPromptInjection(ocrText)) {
    throw new IntegrityViolation('MANIPULATION_DETECTED')
  }
  verifyReceiptIntegrity(receipt, order)
}
