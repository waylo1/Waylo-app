import { prisma } from '../db'
import { EscrowStatus } from '../generated/prisma'
import { substitutionCeilingCents, substitutionHardCapCents } from '../missions/mission-common'

/**
 * Service escrow — capture du séquestre (T1) réutilisable hors route.
 *
 * RESPONSABILITÉ UNIQUE : déclencher l'appel Stripe `paymentIntents.capture`.
 * Ce service N'ÉCRIT RIEN en DB — aucun changement de statut, aucun ledger.
 *
 * SOURCE DE VÉRITÉ : le webhook payment_intent.succeeded, à réception, porte
 * l'intégralité de l'effet (escrow HELD → RELEASED, ledger CAPTURE/PAYOUT/
 * COMMISSION, TransferOutbox, mission → RELEASED). Capturer côté Stripe est le
 * SEUL déclencheur ; la cohérence DB suit l'événement, jamais en avance.
 *
 * Règle d'or projet respectée par construction : aucun appel Stripe dans une
 * transaction DB (il n'y a plus de transaction DB ici).
 *
 * IDEMPOTENCE (AUDIT-00-IDEM) — clé unique : `waylo:<missionId>:cap:<context>:v1`.
 * `<context>` identifie le CHEMIN métier appelant (validate/receipt/receive/
 * collection/customs/payout/timeout) : ce service est désormais le SEUL point
 * d'appel Stripe capture du projet — les anciens appels directs (customs-approve,
 * admin/resolve-payout, timeout collecte) sont centralisés ici. Un retry ou un
 * double appel SUR LE MÊME chemin ne débite qu'une fois (même clé → Stripe
 * dédoublonne). Deux chemins DIFFÉRENTS sur la même mission ont des clés
 * distinctes (Stripe ne les dédoublonne PAS entre eux) : la garde
 * `EscrowStatus.HELD` ci-dessous reste la protection inter-chemins — et Stripe
 * refuse par construction toute capture sur un PaymentIntent déjà capturé,
 * quelle que soit la clé fournie.
 * `:v1` : à incrémenter si la formule de calcul du montant change, pour ne
 * jamais rejouer une réponse Stripe mise en cache sous l'ancienne formule.
 */

/** Chemins métier autorisés à déclencher une capture — un par route/worker appelant. */
export type CaptureContext =
  | 'validate'
  | 'receipt'
  | 'receive'
  | 'collection'
  | 'customs'
  | 'payout'
  | 'timeout'

function buildCaptureIdempotencyKey(missionId: string, context: CaptureContext): string {
  return `waylo:${missionId}:cap:${context}:v1`
}

/** Surface Stripe minimale requise par ce service — seul `paymentIntents.capture` est appelé. */
export interface CaptureStripeClient {
  paymentIntents: {
    capture(
      id: string,
      params: { amount_to_capture?: number },
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
}

export class EscrowCaptureError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'EscrowCaptureError'
  }
}

export interface CaptureEscrowResult {
  escrowId: string
  stripePaymentIntentId: string
  /** Montant demandé à la capture (centimes Int). Le montant CAPTURÉ effectif est confirmé par le webhook. */
  capturedAmountCents: number
}

/**
 * Capture les fonds séquestrés d'une mission côté Stripe — et rien d'autre.
 *
 * Le client Stripe est injecté (surface minimale CaptureStripeClient) —
 * testable, miroir des routes. Lecture seule en DB (préconditions) ; erreurs
 * typées (code SNAKE_CASE) : ESCROW_NOT_FOUND, ESCROW_NOT_HELD. La mise à jour
 * DB est laissée au webhook. `context` identifie le chemin appelant pour la
 * clé d'idempotence (cf. en-tête de fichier).
 */
export async function captureEscrowFunds(
  missionId: string,
  stripe: CaptureStripeClient,
  context: CaptureContext,
): Promise<CaptureEscrowResult> {
  // Lecture seule : récupère le PaymentIntent lié + vérifie l'état capturable.
  const escrow = await prisma.escrowTransaction.findUnique({
    where: { missionId },
    select: {
      id: true,
      stripePaymentIntentId: true,
      status: true,
      mission: {
        select: { budgetCents: true, commissionCents: true, substitutionAuthorized: true },
      },
    },
  })
  if (!escrow) throw new EscrowCaptureError('ESCROW_NOT_FOUND')
  if (escrow.status !== EscrowStatus.HELD) throw new EscrowCaptureError('ESCROW_NOT_HELD')

  // Montant EXACT = total séquestré, centimes Int — miroir de POST /:id/intent.
  // Modèle « Drive » (S18) : si la substitution est pré-autorisée, on capture
  // l'INTÉGRALITÉ du montant provisionné (120% du budget + commission) ; le webhook
  // décompose ensuite PAYOUT (dépense réelle) + COMMISSION + reliquat Wallet acheteur.
  // Sinon, budget + commission (inchangé). La commission est le frais plateforme.
  const heldBudgetCents = escrow.mission.substitutionAuthorized
    ? substitutionCeilingCents(escrow.mission.budgetCents)
    : escrow.mission.budgetCents

  // BACKSTOP 150% (audit robustesse) : aucun montant de substitution ne peut être
  // capturé au-delà du plafond dur, même si la logique 120% régressait. Refus AVANT
  // tout appel Stripe (rien capturé) → erreur typée, jamais un débit hors borne.
  if (heldBudgetCents > substitutionHardCapCents(escrow.mission.budgetCents)) {
    throw new EscrowCaptureError('SUBSTITUTION_HARD_CAP_EXCEEDED')
  }

  const capturedAmountCents = heldBudgetCents + escrow.mission.commissionCents

  // SEUL effet du service : la capture Stripe. `amount_to_capture` EXPLICITE :
  // on capture le montant métier exact (= montant autorisé), jamais « ce que
  // Stripe a sous la main » — source unique pour tous les chemins de capture.
  await stripe.paymentIntents.capture(
    escrow.stripePaymentIntentId,
    { amount_to_capture: capturedAmountCents },
    { idempotencyKey: buildCaptureIdempotencyKey(missionId, context) },
  )

  return {
    escrowId: escrow.id,
    stripePaymentIntentId: escrow.stripePaymentIntentId,
    capturedAmountCents,
  }
}
