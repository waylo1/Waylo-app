import type { PrismaClient } from '../generated/prisma'
import {
  AuthDecision,
  EscrowStatus,
  LedgerType,
  MissionStatus,
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
 *   A. Σ(CAPTURE) == capturedAmountCents                                 (tout escrow)
 *   B. Σ(PAYOUT + COMMISSION + REFUND + BUYER_WALLET_CREDIT) ≤ Σ(CAPTURE) (tout escrow)
 *   C. statut ∈ {RELEASED, REFUNDED} ⇒ Σ(PAYOUT+COMMISSION+REFUND+BUYER_WALLET_CREDIT) == Σ(CAPTURE)
 *   (BUYER_WALLET_CREDIT = reliquat de substitution « Drive », S18 — part de la capture.)
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
  paymentIntents: {
    retrieve(id: string): Promise<{ amount_received: number }>
    /** Annule un PI non encore capturé (HELD). Utilisé pour le timeout douanier. */
    cancel(id: string, opts?: { idempotencyKey?: string }): Promise<{ id: string }>
    /** Capture (T1) un PI HELD. Utilisé pour le timeout collecte (auto-libération).
     *  Signature 3-arg (id, params, options) = SDK Stripe réel : idempotencyKey en options. */
    capture(
      id: string,
      params: { amount_to_capture?: number },
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
}

export interface ReconciliationDeps {
  prisma: PrismaClient
  /** Optionnel : sans client Stripe, les contrôles côté Stripe sont sautés (logués). */
  stripe?: StripeReconciliationClient
  /** Hook d'alerte configurable (pager, Slack…). Défaut : log structuré stderr. */
  onAlert?: AlertSink
  /** X heures avant qu'une autorisation APPROVED sans capture ne déclenche une alerte. */
  authWithoutCaptureHours?: number
  /**
   * Fenêtre de grâce d'un PAYOUT non réglé, en minutes (défaut 60). Couvre le
   * chemin nominal du worker : tick ~1 min + 5 tentatives en backoff 2^n min
   * (≈ 31 min cumulées). Sous le seuil = transitoire normal, pas d'alerte ;
   * au-delà, le nag reprend à chaque run tant que l'argent n'est pas réglé.
   */
  payoutSettleGraceMinutes?: number
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
      sumOf(escrow.id, LedgerType.REFUND) +
      // Reliquat de substitution recrédité au Wallet acheteur (S18) : part de la
      // capture, comptée dans la décomposition (CAPTURE = PAYOUT+COMMISSION+WALLET).
      sumOf(escrow.id, LedgerType.BUYER_WALLET_CREDIT)
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
  const payoutGraceMinutes = deps.payoutSettleGraceMinutes ?? 60
  const payoutGraceCutoff = new Date(Date.now() - payoutGraceMinutes * 60 * 1000)
  const payouts = await prisma.ledgerEntry.findMany({
    where: { type: LedgerType.PAYOUT },
    select: { id: true, escrowId: true, amountCents: true, createdAt: true },
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
    if (settledCents < payout.amountCents && payout.createdAt < payoutGraceCutoff) {
      // Fenêtre de grâce : un PAYOUT plus récent que le seuil est un transitoire
      // normal (worker pas encore passé / retries en cours) — pas d'alerte.
      // Au-delà : nag volontaire — tant que l'argent réclamé n'est pas réglé
      // (y compris outbox ABANDONED), l'écart reste signalé à chaque run.
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

  // ── 6. Timeout douanier — missions ESCROW_LOCKED_CUSTOMS > 7 jours ─────────
  // Une mission sans re-soumission de quittance pendant 7 jours dépasse le SLA
  // (rules.md §2 : timeout = annulation/remboursement). Le PI est toujours en
  // requires_capture (jamais capturé depuis ce statut) : on l'annule côté Stripe
  // puis on clôt atomiquement mission + entrée REFUND (amountCents = 0 car pré-capture).
  if (deps.stripe) {
    const CUSTOMS_TIMEOUT_DAYS = 7
    const customsTimeoutCutoff = new Date(Date.now() - CUSTOMS_TIMEOUT_DAYS * 24 * 3600 * 1000)
    const stalledCustoms = await prisma.mission.findMany({
      where: {
        status: MissionStatus.ESCROW_LOCKED_CUSTOMS,
        updatedAt: { lt: customsTimeoutCutoff },
      },
      select: {
        id: true,
        escrow: { select: { id: true, stripePaymentIntentId: true } },
      },
    })

    for (const mission of stalledCustoms) {
      if (!mission.escrow) continue

      try {
        await deps.stripe.paymentIntents.cancel(mission.escrow.stripePaymentIntentId, {
          idempotencyKey: `refund_customs_${mission.id}`,
        })
      } catch (err) {
        emit({
          code: 'CUSTOMS_TIMEOUT_REFUND_FAILED',
          message: 'Annulation Stripe échouée pour timeout douanier — mission ESCROW_LOCKED_CUSTOMS > 7 j',
          details: {
            missionId: mission.id,
            stripePaymentIntentId: mission.escrow.stripePaymentIntentId,
            err: String(err),
          },
        })
        continue
      }

      await prisma.$transaction(async tx => {
        await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.ESCROW_LOCKED_CUSTOMS },
          data: { status: MissionStatus.REFUNDED },
        })
        await tx.ledgerEntry.create({
          data: {
            escrowId: mission.escrow!.id,
            type: LedgerType.REFUND,
            amountCents: 0,
          },
        })
      })
    }
  }

  // ── 7. Timeout collecte acheteur — missions DEPOSITED > 5 jours ────────────
  // L'acheteur n'a pas confirmé la collecte du colis déposé pendant 5 jours : on
  // libère automatiquement le séquestre vers le voyageur (auto-confirmation).
  // Miroir AUTOMATISÉ de /confirm-collection — MÊME chemin financier, MÊMES invariants :
  // capture Stripe HORS tx → DEPOSITED → VALIDATED (transitoire) → le webhook
  // payment_intent.succeeded journalise PAYOUT/COMMISSION + crée le TransferOutbox
  // (transfer-worker = unique exécutant) → RELEASED. AUCUNE écriture ledger ici
  // (portée par le webhook), AUCUN transfers.create (pattern outbox préservé).
  if (deps.stripe) {
    const COLLECTION_TIMEOUT_DAYS = 5
    const collectionTimeoutCutoff = new Date(Date.now() - COLLECTION_TIMEOUT_DAYS * 24 * 3600 * 1000)
    const stalledCollection = await prisma.mission.findMany({
      where: {
        status: MissionStatus.DEPOSITED,
        dropoffAt: { lt: collectionTimeoutCutoff },
      },
      select: {
        id: true,
        escrow: { select: { stripePaymentIntentId: true, status: true } },
      },
    })

    for (const mission of stalledCollection) {
      // Sans escrow HELD, rien à capturer (déjà libéré/refundé/annulé) — on saute.
      if (!mission.escrow || mission.escrow.status !== EscrowStatus.HELD) continue

      try {
        await deps.stripe.paymentIntents.capture(
          mission.escrow.stripePaymentIntentId,
          {},
          { idempotencyKey: `timeout_collection_${mission.id}` },
        )
      } catch (err) {
        // Échec technique (carte expirée, erreur Stripe) : la capture n'a pas eu
        // lieu, le voyageur n'est pas payé, l'autorisation vieillit → intervention
        // humaine. Alerte critique, et on continue la boucle (pas d'arrêt du worker).
        emit({
          code: 'COLLECTION_TIMEOUT_CAPTURE_FAILED',
          message: 'Capture Stripe échouée pour timeout collecte — mission DEPOSITED > 5 j, intervention humaine requise',
          details: {
            missionId: mission.id,
            stripePaymentIntentId: mission.escrow.stripePaymentIntentId,
            err: String(err),
          },
        })
        continue
      }

      // Transition conditionnelle (anti-TOCTOU) DEPOSITED → VALIDATED. count 0 =
      // collecte déjà confirmée par l'acheteur / tick concurrent : bénin (la capture
      // est idempotente et le webhook finalisera) — pas d'alerte.
      await prisma.$transaction(async tx => {
        await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.DEPOSITED },
          data: { status: MissionStatus.VALIDATED },
        })
      })
    }
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
