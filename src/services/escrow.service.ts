import { prisma } from '../db'
import { EscrowStatus } from '../generated/prisma'
import { substitutionCeilingCents, type PaymentIntentClient } from '../missions/mission-common'

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
 * transaction DB (il n'y a plus de transaction DB ici). idempotencyKey
 * `capture_<missionId>` partagée avec la route /validate → un seul débit Stripe
 * par mission, quel que soit le chemin appelant.
 */
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
 * Le client Stripe est injecté (cf. PaymentIntentClient) — testable, miroir des
 * routes. Lecture seule en DB (préconditions) ; erreurs typées (code SNAKE_CASE) :
 * ESCROW_NOT_FOUND, ESCROW_NOT_HELD. La mise à jour DB est laissée au webhook.
 */
export async function captureEscrowFunds(
  missionId: string,
  stripe: PaymentIntentClient,
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
  const capturedAmountCents = heldBudgetCents + escrow.mission.commissionCents

  // SEUL effet du service : la capture Stripe. idempotencyKey déterministe —
  // un retry post-crash ou un double appel capture le MÊME PI une seule fois.
  await stripe.paymentIntents.capture(
    escrow.stripePaymentIntentId,
    { amount_to_capture: capturedAmountCents },
    { idempotencyKey: `capture_${missionId}` },
  )

  return {
    escrowId: escrow.id,
    stripePaymentIntentId: escrow.stripePaymentIntentId,
    capturedAmountCents,
  }
}
