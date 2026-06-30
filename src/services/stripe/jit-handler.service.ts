import type Stripe from 'stripe'
import { EscrowStatus, MissionStatus } from '../../generated/prisma'
import { substitutionHardCapCents } from '../../missions/mission-common'

/**
 * Cœur de décision JIT (Stripe Issuing — Option B, financement just-in-time).
 *
 * RÔLE : extraire la logique de décision actuellement INLINE dans
 * `src/stripe/issuing-authorization.route.ts` vers une fonction PURE, sans I/O,
 * testable hors DB (proof DB-free `scripts/jit-proof.mts`). La route reste la
 * coquille I/O (signature, lecture indexée escrow, audit fire-and-forget) ; elle
 * délègue la décision à `decideJitAuthorization`.
 *
 * INVARIANTS (cf. .claude/CLAUDE.md, gotchas.md) :
 *  - Centimes Int partout, jamais Float.
 *  - Défaut = REFUS : tout doute (carte inconnue, escrow non HELD, mission gelée,
 *    montant absent) → approved:false.
 *  - Aucun appel réseau, aucune agrégation, aucun write : chemin critique < 2 s.
 *  - Le plafond (Spending Control) est posé UNE fois à l'émission ; ici contrôle
 *    UNITAIRE par autorisation, le cumul est borné par Stripe.
 *
 * ÉTAT : SIGNATURES UNIQUEMENT (init). Les corps lèvent NOT_IMPLEMENTED ;
 * `scripts/jit-proof.mts` est le spec exécutable (RED) qui passera au VERT à
 * l'implémentation. Aucune logique n'est dupliquée tant que ce TODO n'est pas levé.
 */

// ---------------------------------------------------------------------------
// CONTRAT DE DONNÉE — Entrée (côté Stripe)
// ---------------------------------------------------------------------------

/** Requête JIT brute = objet d'autorisation Stripe (event `issuing_authorization.request`). */
export type JitAuthorizationRequest = Stripe.Issuing.Authorization

/** Faits extraits de l'event Stripe, découplés du SDK pour le cœur pur. */
export interface JitAuthorizationFacts {
  /** `data.object.id` — idempotence de l'audit (@unique stripeAuthorizationId). */
  authorizationId: string
  /** `data.object.card.id` — clé de lookup escrow (stripeIssuingCardId @unique). */
  cardId: string
  /** `pending_request.amount` en centimes Int, ou null si absent. */
  requestedAmountCents: number | null
}

/**
 * Entrée NORMALISÉE du cœur de décision — uniquement des faits déjà lus en DB.
 * `escrow`/`mission` à null = carte inconnue. Aucune dépendance Prisma runtime :
 * seuls les TYPES d'enum sont importés (proof DB-free).
 */
export interface JitDecisionInput {
  requestedAmountCents: number | null
  escrow: {
    status: EscrowStatus
    /** Plafond figé au financement (= budget, ou 120% si substitution pré-autorisée). */
    spendingLimitCents: number
  } | null
  mission: {
    status: MissionStatus
    substitutionAuthorized: boolean
    budgetCents: number
  } | null
}

// ---------------------------------------------------------------------------
// CONTRAT DE DONNÉE — Sortie (réponse attendue)
// ---------------------------------------------------------------------------

/**
 * Code de refus Stripe (miroir de `Issuing.Authorization.request_history[].reason`).
 * Sous-ensemble pertinent pour notre garde JIT — voir mapping interne → Stripe.
 */
export type StripeDeclineReason =
  | 'insufficient_funds' // montant > solde/plafond escrow ; escrow non HELD
  | 'spending_controls' // backstop hard cap 150% dépassé
  | 'not_allowed' // mission gelée (DISPUTED/CANCELLED), montant absent
  | 'card_inactive' // carte inconnue de notre source de vérité

/** Motif interne (audit `IssuingAuthorizationLog.reason`, miroir des codes actuels). */
export type JitInternalReason =
  | 'WITHIN_BUDGET'
  | 'NO_PENDING_AMOUNT'
  | 'UNKNOWN_CARD'
  | 'MISSION_DISPUTED'
  | 'MISSION_CANCELLED'
  | 'ESCROW_NOT_HELD'
  | 'OVER_BUDGET'
  | 'HARD_CAP_EXCEEDED'

/** Décision pure : approbation + motif d'audit interne + code Stripe (null si approuvé). */
export interface JitAuthorizationDecision {
  approved: boolean
  reason: JitInternalReason
  /** Code de refus Stripe à journaliser ; null ⇔ approved === true. */
  declineCode: StripeDeclineReason | null
}

/** Réponse synchrone réellement renvoyée au webhook Stripe (< 2 s). */
export interface JitWebhookReply {
  approved: boolean
}

// ---------------------------------------------------------------------------
// SIGNATURES — corps NON implémentés (init). Voir scripts/jit-proof.mts (RED).
// ---------------------------------------------------------------------------

/**
 * Extrait les faits décisionnels d'un event Stripe `issuing_authorization.request`.
 * NE valide PAS la signature (responsabilité de la route). Lève si l'event n'est
 * pas du bon type.
 */
export function parseAuthorizationEvent(event: Stripe.Event): JitAuthorizationFacts {
  if (event.type !== 'issuing_authorization.request') {
    throw new Error(`UNEXPECTED_EVENT_TYPE: ${event.type}`)
  }
  const authorization = event.data.object as Stripe.Issuing.Authorization
  return {
    authorizationId: authorization.id,
    cardId: authorization.card.id,
    requestedAmountCents: authorization.pending_request?.amount ?? null,
  }
}

/**
 * CŒUR PUR. Décide approbation/refus à partir des seuls faits normalisés.
 * Déterministe, sans I/O, sans Float. Cible du proof DB-free.
 *
 * Ordre de gardes (fail-safe, défaut = refus) :
 *  1. montant absent/≤0 → NO_PENDING_AMOUNT / not_allowed
 *  2. escrow|mission null → UNKNOWN_CARD / card_inactive
 *  3. mission DISPUTED → MISSION_DISPUTED / not_allowed
 *  4. mission CANCELLED → MISSION_CANCELLED / not_allowed
 *  5. escrow ≠ HELD → ESCROW_NOT_HELD / insufficient_funds
 *  6. montant > hardCap(150% budget) → HARD_CAP_EXCEEDED / spending_controls
 *  7. montant > plafond (spendingLimitCents, 120% si substitution) → OVER_BUDGET / insufficient_funds
 *  8. sinon → WITHIN_BUDGET / approved
 */
export function decideJitAuthorization(input: JitDecisionInput): JitAuthorizationDecision {
  const { requestedAmountCents, escrow, mission } = input

  if (requestedAmountCents === null || requestedAmountCents <= 0) {
    return { approved: false, reason: 'NO_PENDING_AMOUNT', declineCode: 'not_allowed' }
  }

  if (!escrow || !mission) {
    return { approved: false, reason: 'UNKNOWN_CARD', declineCode: 'card_inactive' }
  }

  if (mission.status === MissionStatus.DISPUTED) {
    return { approved: false, reason: 'MISSION_DISPUTED', declineCode: 'not_allowed' }
  }

  if (mission.status === MissionStatus.CANCELLED) {
    return { approved: false, reason: 'MISSION_CANCELLED', declineCode: 'not_allowed' }
  }

  if (escrow.status !== EscrowStatus.HELD) {
    return { approved: false, reason: 'ESCROW_NOT_HELD', declineCode: 'insufficient_funds' }
  }

  // Plafond unitaire — modèle « Drive » (S17) : 120% du budget si substitution
  // pré-autorisée (cohérent avec l'escrow + Spending Control dimensionnés à
  // l'émission), sinon plafond figé de l'escrow (= budget).
  const ceilingCents = mission.substitutionAuthorized
    ? Math.floor((mission.budgetCents * 12) / 10)
    : escrow.spendingLimitCents

  // BACKSTOP 150% : borne dure indépendante du plafond opérationnel, refus
  // fail-safe même si le calcul du plafond régressait.
  if (requestedAmountCents > substitutionHardCapCents(mission.budgetCents)) {
    return { approved: false, reason: 'HARD_CAP_EXCEEDED', declineCode: 'spending_controls' }
  }

  if (requestedAmountCents > ceilingCents) {
    return { approved: false, reason: 'OVER_BUDGET', declineCode: 'insufficient_funds' }
  }

  return { approved: true, reason: 'WITHIN_BUDGET', declineCode: null }
}

/** Projette la décision pure sur la réponse synchrone minimale envoyée à Stripe. */
export function toWebhookReply(decision: JitAuthorizationDecision): JitWebhookReply {
  return { approved: decision.approved }
}
