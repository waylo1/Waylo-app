import type { PrismaClient } from '../generated/prisma'
import {
  AuthDecision,
  EscrowStatus,
  LedgerType,
  TransferStatus,
} from '../generated/prisma'
import { AlertSink, OpsAlert, OpsAlertInput, safeEmit } from '../alerts'

/**
 * ═══════════ TIMELINE DU CYCLE DE VIE — source de vérité, ENFORCÉE ═══════════
 *
 * T0  Financement mission : PaymentIntent (capture différée) AUTORISÉ, pas capturé.
 *     EscrowTransaction créée { status: HELD, capturedAmountCents: 0 }, ledger vide.
 * T1  Validation humaine → paymentIntents.capture (HORS transaction DB).
 * T2  Webhook payment_intent.succeeded = LA CAPTURE RÉELLE. Dans UNE transaction :
 *     capturedAmountCents := amount_received + ligne CAPTURE (inconditionnel,
 *     l'argent est pris côté Stripe que le reste passe ou non). Puis précondition
 *     compte Connect voyageur :
 *       OK → T3 dans la même transaction : PAYOUT + COMMISSION + TransferOutbox
 *            PENDING + escrow RELEASED + mission RELEASED.
 *       KO → escrow reste HELD (post-capture), mission AWAITING_TRAVELER_ACCOUNT,
 *            alerte TRAVELER_ACCOUNT_MISSING, réponse 200. La reprise de la
 *            libération est une action explicite (ops/API), pas un rejeu webhook.
 * T2' charge.refunded : UNIQUEMENT post-capture (Stripe exige une charge capturée ;
 *     applyRefund abort + alerte si capturedAmountCents == 0). Delta journalisé
 *     sous verrou FOR UPDATE. HELD|PARTIALLY_REFUNDED → PARTIALLY_REFUNDED|REFUNDED.
 * T4  Worker de transfert : PENDING → SUBMITTED → SETTLED | FAILED (retries,
 *     backoff) | ABANDONED (M tentatives, terminal, alerte unique « needs human »).
 *
 * TRANCHÉ : PARTIALLY_REFUNDED PRÉ-libération EST atteignable (refund entre la
 * capture et une libération différée, ex. AWAITING_TRAVELER_ACCOUNT), mais
 * TOUJOURS POST-capture : capturedAmountCents > 0 et la ligne CAPTURE existent
 * déjà (écrites à T2). Il n'existe AUCUN état où un REFUND légitime précède la
 * CAPTURE — l'ambiguïté « CAPTURE journalisée à la libération » est levée :
 * CAPTURE et capturedAmountCents s'écrivent à la capture, JAMAIS à la libération.
 *
 * Écritures : CAPTURE + capturedAmountCents → T2 ; PAYOUT + COMMISSION → T3 ;
 * REFUND → T2'. Ledger append-only : jamais d'UPDATE/DELETE.
 *
 * INVARIANTS (uniformes — AUCUN relâchement par statut) :
 *   A. Σ(CAPTURE) == capturedAmountCents                     (tout escrow)
 *   B. Σ(PAYOUT + COMMISSION + REFUND) ≤ Σ(CAPTURE)          (tout escrow)
 *   C. statut ∈ {RELEASED, REFUNDED} ⇒ Σ(PAYOUT+COMMISSION+REFUND) == Σ(CAPTURE)
 * Un escrow pré-capture (HELD, capturedAmountCents 0, ledger vide) satisfait
 * A et B trivialement — un seul chemin de code, pas de cas particulier.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Réconciliation quotidienne — DÉTECTE et ALERTE, ne mute JAMAIS le ledger.
 * Le ledger est append-only : tout écart est un bug à investiguer, pas un état
 * transitoire à corriger. Seule remédiation : requeueFailedTransfer (FAILED →
 * PENDING, jamais ABANDONED) — le worker reste l'unique exécutant des versements.
 * Idempotente et relançable : lectures seules + émission d'alertes.
 */

export type ReconciliationAlert = OpsAlert

/** Surface Stripe minimale — confronte le ledger à l'état d'argent RÉEL. */
export interface StripeReconciliationClient {
  transfers: { retrieve(id: string): Promise<unknown> }
  paymentIntents: { retrieve(id: string): Promise<{ amount_received: number }> }
}

export interface ReconciliationDeps {
  prisma: PrismaClient
  /** Optionnel : sans client Stripe, les contrôles côté Stripe sont sautés (logués). */
  stripe?: StripeReconciliationClient
  /** Hook d'alerte configurable (pager, Slack…). Défaut : log structuré stderr. */
  onAlert?: AlertSink
  /** X heures avant qu'une autorisation APPROVED sans capture ne déclenche une alerte. */
  authWithoutCaptureHours?: number
  /** Fenêtre de vérification Stripe des transferts SETTLED récents. */
  transferCheckWindowDays?: number
  /** Fenêtre de confrontation ledger ↔ captures réelles Stripe. */
  captureCheckWindowDays?: number
}

export async function runReconciliation(
  deps: ReconciliationDeps,
): Promise<ReconciliationAlert[]> {
  const { prisma } = deps
  const alerts: ReconciliationAlert[] = []
  const emit = (input: OpsAlertInput): void => {
    // safeEmit dérive la sévérité du code — on collecte l'alerte enrichie.
    alerts.push(safeEmit(deps.onAlert, input))
  }

  // ── 1. Invariants comptables A/B/C — uniformes sur TOUS les escrows ──────
  const escrows = await prisma.escrowTransaction.findMany({
    select: {
      id: true,
      status: true,
      capturedAmountCents: true,
      stripePaymentIntentId: true,
      createdAt: true,
    },
  })
  const ledgerSums = await prisma.ledgerEntry.groupBy({
    by: ['escrowId', 'type'],
    _sum: { amountCents: true },
  })
  const sumOf = (escrowId: string, type: LedgerType): number =>
    ledgerSums.find(s => s.escrowId === escrowId && s.type === type)?._sum.amountCents ?? 0

  const SETTLED_STATUSES: EscrowStatus[] = [EscrowStatus.RELEASED, EscrowStatus.REFUNDED]

  for (const escrow of escrows) {
    const capture = sumOf(escrow.id, LedgerType.CAPTURE)
    const outflow =
      sumOf(escrow.id, LedgerType.PAYOUT) +
      sumOf(escrow.id, LedgerType.COMMISSION) +
      sumOf(escrow.id, LedgerType.REFUND)
    const details = {
      escrowId: escrow.id,
      status: escrow.status,
      capture,
      outflow,
      capturedAmountCents: escrow.capturedAmountCents,
    }

    // A. La capture journalisée == la capture enregistrée sur l'escrow.
    if (capture !== escrow.capturedAmountCents) {
      emit({
        code: 'LEDGER_INVARIANT_BROKEN',
        message: 'Σ(CAPTURE) != capturedAmountCents',
        details,
      })
    }
    // B. Jamais plus de sorties que de capture — vrai garde-fou : depuis le
    // correctif T2, capturedAmountCents est peuplé À la capture, plus jamais
    // une comparaison à 0.
    if (outflow > capture) {
      emit({
        code: 'LEDGER_INVARIANT_BROKEN',
        message: 'Σ(PAYOUT+COMMISSION+REFUND) > Σ(CAPTURE)',
        details,
      })
    }
    // C. États soldés : équilibre exact.
    if (SETTLED_STATUSES.includes(escrow.status) && outflow !== capture) {
      emit({
        code: 'LEDGER_INVARIANT_BROKEN',
        message: 'Escrow soldé déséquilibré : Σ(PAYOUT+COMMISSION+REFUND) != Σ(CAPTURE)',
        details,
      })
    }
  }

  // ── 2. Croisement PAYOUT ↔ TransferOutbox ────────────────────────────────
  const payouts = await prisma.ledgerEntry.findMany({
    where: { type: LedgerType.PAYOUT },
    select: { id: true, escrowId: true, amountCents: true },
  })
  const outboxes = await prisma.transferOutbox.findMany({
    select: {
      id: true,
      escrowId: true,
      status: true,
      amountCents: true,
      stripeTransferId: true,
      attempts: true,
      createdAt: true,
    },
  })
  const settledByEscrow = new Map<string, number>()
  for (const o of outboxes) {
    if (o.status === TransferStatus.SETTLED) {
      settledByEscrow.set(o.escrowId, (settledByEscrow.get(o.escrowId) ?? 0) + o.amountCents)
    }
  }

  for (const payout of payouts) {
    const settledCents = settledByEscrow.get(payout.escrowId) ?? 0
    if (settledCents < payout.amountCents) {
      // Nag volontaire : tant que l'argent réclamé n'est pas réglé (y compris
      // outbox ABANDONED), l'écart financier reste signalé à chaque run.
      // L'alerte « needs human » unique de l'abandon, elle, est émise une seule
      // fois par le worker (TRANSFER_ABANDONED).
      emit({
        code: 'PAYOUT_NOT_SETTLED',
        message: 'Versement réclamé au ledger mais non réglé côté outbox',
        details: {
          escrowId: payout.escrowId,
          ledgerEntryId: payout.id,
          payoutCents: payout.amountCents,
          settledCents,
        },
      })
    }
  }

  const payoutEscrowIds = new Set(payouts.map(p => p.escrowId))
  for (const outbox of outboxes) {
    if (outbox.status === TransferStatus.SETTLED && !payoutEscrowIds.has(outbox.escrowId)) {
      emit({
        code: 'ORPHAN_TRANSFER',
        message: 'Mouvement sortant réglé sans PAYOUT correspondant au ledger',
        details: { outboxId: outbox.id, escrowId: outbox.escrowId },
      })
    }
  }

  // ── 3. Existence réelle des transferts récents côté Stripe ───────────────
  if (deps.stripe) {
    const windowDays = deps.transferCheckWindowDays ?? 7
    const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000)
    const recentSettled = outboxes.filter(
      o => o.status === TransferStatus.SETTLED && o.stripeTransferId && o.createdAt >= since,
    )
    for (const outbox of recentSettled) {
      try {
        await deps.stripe.transfers.retrieve(outbox.stripeTransferId as string)
      } catch {
        emit({
          code: 'TRANSFER_MISSING_ON_STRIPE',
          message: 'stripeTransferId réglé en DB mais introuvable côté Stripe',
          details: { outboxId: outbox.id, stripeTransferId: outbox.stripeTransferId },
        })
      }
    }

    // ── 4. Ledger ↔ capture RÉELLE Stripe (pas le proxy Receipt) ───────────
    // L'argent capturé existe côté Stripe que notre transaction ait committé
    // ou non : c'est LE contrôle qui rend visible une capture jamais
    // journalisée (rollback historique, bug) — et l'inverse.
    const captureWindowDays = deps.captureCheckWindowDays ?? 7
    const captureSince = new Date(Date.now() - captureWindowDays * 24 * 3600 * 1000)
    for (const escrow of escrows.filter(e => e.createdAt >= captureSince)) {
      const hasCaptureLine = sumOf(escrow.id, LedgerType.CAPTURE) > 0
      let capturedOnStripe: boolean | null = null // null = PI introuvable/erreur
      try {
        const intent = await deps.stripe.paymentIntents.retrieve(escrow.stripePaymentIntentId)
        capturedOnStripe = intent.amount_received > 0
      } catch {
        capturedOnStripe = null
      }

      if (capturedOnStripe === true && !hasCaptureLine && escrow.status !== EscrowStatus.RELEASED) {
        emit({
          code: 'CAPTURE_WITHOUT_LEDGER',
          message: 'Argent capturé côté Stripe sans ligne CAPTURE au ledger',
          details: {
            escrowId: escrow.id,
            stripePaymentIntentId: escrow.stripePaymentIntentId,
            status: escrow.status,
          },
        })
      }
      if (capturedOnStripe !== true && hasCaptureLine) {
        emit({
          code: 'LEDGER_CAPTURE_NOT_CONFIRMED',
          message: 'Ligne CAPTURE au ledger sans capture confirmée côté Stripe',
          details: {
            escrowId: escrow.id,
            stripePaymentIntentId: escrow.stripePaymentIntentId,
            paymentIntentFound: capturedOnStripe !== null,
          },
        })
      }
    }
  }

  // ── 5. Autorisations APPROVED sans capture Issuing après X h ─────────────
  // Périmètre Issuing (achats carte en magasin) : le Receipt scellé reste le
  // marqueur de capture côté mission — distinct du contrôle 4 (PI acheteur).
  const maxAgeHours = deps.authWithoutCaptureHours ?? 24
  const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000)
  const danglingAuths = await prisma.issuingAuthorizationLog.findMany({
    where: {
      decision: AuthDecision.APPROVED,
      createdAt: { lt: cutoff },
      OR: [{ missionId: null }, { mission: { receipt: { is: null } } }],
    },
    select: { id: true, missionId: true, stripeAuthorizationId: true, createdAt: true },
  })
  for (const auth of danglingAuths) {
    emit({
      code: 'AUTHORIZATION_WITHOUT_CAPTURE',
      message: `Autorisation approuvée sans capture associée après ${maxAgeHours} h`,
      details: {
        stripeAuthorizationId: auth.stripeAuthorizationId,
        missionId: auth.missionId,
        approvedAt: auth.createdAt.toISOString(),
      },
    })
  }

  return alerts
}

/**
 * Remédiation autorisée : remettre une ligne FAILED en file. Le worker la
 * rejouera à son prochain tick — AUCUNE exécution de transfert ici, le chemin
 * d'exécution reste unique. Transition conditionnelle (anti-TOCTOU), attempts
 * conservé : le compteur continue de courir vers le seuil M d'abandon, le
 * cycle FAILED→PENDING ne peut donc PAS reboucler indéfiniment — au M-ième
 * échec le worker passe la ligne en ABANDONED (terminal, hors scope requeue).
 */
export async function requeueFailedTransfer(
  prisma: PrismaClient,
  outboxId: string,
): Promise<boolean> {
  const res = await prisma.transferOutbox.updateMany({
    where: { id: outboxId, status: TransferStatus.FAILED }, // jamais ABANDONED
    data: { status: TransferStatus.PENDING, lastError: null },
  })
  return res.count === 1
}
