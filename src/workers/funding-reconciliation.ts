import type { PrismaClient } from '../generated/prisma'
import { EscrowStatus, MissionStatus } from '../generated/prisma'
import { AlertSink, safeEmit } from '../alerts'
import type { WorkerLogger } from './transfer-worker'

/**
 * Réconciliation des financements ABANDONNÉS (cron ~15 min).
 *
 * Une mission passe FUNDED dès l'INITIATION du financement : /intent et
 * /checkout-session réservent CREATED → FUNDED AVANT le paiement. Si l'acheteur
 * ne confirme jamais, le PaymentIntent reste NON AUTORISÉ et la mission est
 * bloquée en FUNDED. Ce worker détecte ces réservations abandonnées (escrow
 * HELD non capturé, plus vieux que staleMinutes) et les ANNULE : escrow
 * HELD → CANCELLED, mission FUNDED → CREATED (re-finançable), PaymentIntent
 * annulé côté Stripe.
 *
 * ⚠️ SÉCURITÉ CAPITALE — on n'annule QUE les PI NON autorisés
 * (requires_payment_method / requires_confirmation). Un PI 'requires_capture'
 * est un SÉQUESTRE LÉGITIME (l'acheteur a payé, fonds tenus) en attente de
 * capture à la validation : il reste FUNDED des JOURS et ne doit JAMAIS être
 * rollback. 'succeeded' (capture en vol) est aussi laissé au webhook. Le statut
 * réel est lu sur Stripe ; au moindre doute on SAUTE (jamais de rollback à tort).
 *
 * Transitions conditionnelles (anti-TOCTOU) : un escrow capturé entre la lecture
 * et l'écriture fait échouer la transition → la mission est sautée. Idempotent
 * et relançable.
 */

// PI sans paiement abouti : seuls états annulables (réservation abandonnée).
const ABANDONED_PI_STATUSES = new Set(['requires_payment_method', 'requires_confirmation'])

/** Surface Stripe minimale — injectable (fake en test, SDK réel en prod). */
export interface FundingReconciliationStripeClient {
  paymentIntents: {
    retrieve(id: string): Promise<{ status: string }>
    cancel(id: string): Promise<{ id: string }>
  }
}

export interface FundingReconciliationDeps {
  prisma: PrismaClient
  stripe: FundingReconciliationStripeClient
  /** Âge minimal d'une réservation FUNDED avant rollback (défaut 30 min). */
  staleMinutes?: number
  /** Bornage d'un passage (le reliquat part au tick suivant). */
  batchLimit?: number
  log?: WorkerLogger
  onAlert?: AlertSink
}

const DEFAULT_STALE_MINUTES = 30
const DEFAULT_BATCH_LIMIT = 100

/** L'escrow/mission a changé d'état entre la lecture et l'écriture (capture concurrente). */
class ConcurrentChangeError extends Error {}

/** Un passage du worker (un tick de cron). Relançable à volonté. */
export async function runFundingReconciliationOnce(
  deps: FundingReconciliationDeps,
): Promise<{ rolledBack: number; cancelFailed: number; skipped: number }> {
  const { prisma, stripe } = deps
  const staleMinutes = deps.staleMinutes ?? DEFAULT_STALE_MINUTES
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT
  const log = deps.log ?? console

  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000)
  const candidates = await prisma.escrowTransaction.findMany({
    where: {
      status: EscrowStatus.HELD,
      capturedAmountCents: 0,
      createdAt: { lt: cutoff },
      mission: { status: MissionStatus.FUNDED },
    },
    select: { id: true, missionId: true, stripePaymentIntentId: true },
    take: batchLimit,
  })

  let rolledBack = 0
  let cancelFailed = 0
  let skipped = 0

  for (const escrow of candidates) {
    // Statut RÉEL du PI : seuls les non-autorisés (jamais payés) sont annulables.
    let piStatus: string
    try {
      piStatus = (await stripe.paymentIntents.retrieve(escrow.stripePaymentIntentId)).status
    } catch (err) {
      skipped++ // doute → on ne touche pas (fail-safe : jamais de rollback à tort)
      log.error({ escrowId: escrow.id, err: String(err) }, 'funding-recon: retrieve PI échoué')
      continue
    }
    if (!ABANDONED_PI_STATUSES.has(piStatus)) {
      skipped++ // requires_capture = séquestre légitime ; succeeded/canceled = géré ailleurs
      continue
    }

    // Rollback atomique conditionnel : escrow HELD+0 → CANCELLED, mission FUNDED → CREATED.
    // Annuler l'escrow EN PREMIER ferme la porte à toute capture (le webhook exige HELD).
    try {
      await prisma.$transaction(async tx => {
        const e = await tx.escrowTransaction.updateMany({
          where: { id: escrow.id, status: EscrowStatus.HELD, capturedAmountCents: 0 },
          data: { status: EscrowStatus.CANCELLED },
        })
        if (e.count !== 1) throw new ConcurrentChangeError()
        const m = await tx.mission.updateMany({
          where: { id: escrow.missionId, status: MissionStatus.FUNDED },
          data: { status: MissionStatus.CREATED },
        })
        if (m.count !== 1) throw new ConcurrentChangeError()
      })
    } catch (err) {
      if (err instanceof ConcurrentChangeError) {
        skipped++
        continue
      }
      throw err
    }
    rolledBack++

    // Libère le PI côté Stripe (best-effort) — l'escrow est déjà CANCELLED en DB,
    // aucune capture ne peut plus le concerner.
    try {
      await stripe.paymentIntents.cancel(escrow.stripePaymentIntentId)
    } catch (err) {
      cancelFailed++
      safeEmit(deps.onAlert, {
        code: 'FUNDING_RECON_CANCEL_FAILED',
        message: 'Annulation Stripe du PaymentIntent abandonné échouée (rollback DB committé)',
        details: {
          missionId: escrow.missionId,
          escrowId: escrow.id,
          stripePaymentIntentId: escrow.stripePaymentIntentId,
          err: String(err),
        },
      })
      log.error({ escrowId: escrow.id, err: String(err) }, 'funding-recon: cancel PI échoué')
    }

    safeEmit(deps.onAlert, {
      code: 'STALE_FUNDING_ROLLED_BACK',
      message: 'Financement abandonné annulé : mission FUNDED → CREATED, séquestre libéré',
      details: {
        missionId: escrow.missionId,
        escrowId: escrow.id,
        stripePaymentIntentId: escrow.stripePaymentIntentId,
        piStatus,
      },
    })
  }

  return { rolledBack, cancelFailed, skipped }
}

/**
 * Boucle cron (~15 min). Garde `inFlight` : un tick qui arrive pendant un run en
 * cours est SAUTÉ (jamais deux runs concurrents) ; `stop()` attend la fin du run
 * en vol.
 */
export function startFundingReconciliationLoop(
  deps: FundingReconciliationDeps,
  intervalMs = 15 * 60_000,
): { stop(): Promise<void> } {
  const log = deps.log ?? console
  let inFlight: Promise<unknown> | null = null
  const tick = (): void => {
    if (inFlight) return
    inFlight = runFundingReconciliationOnce(deps)
      .catch((err: unknown) =>
        log.error({ err: String(err) }, 'funding reconciliation tick failed'),
      )
      .finally(() => {
        inFlight = null
      })
  }
  const timer = setInterval(tick, intervalMs)
  return {
    async stop(): Promise<void> {
      clearInterval(timer)
      if (inFlight) await inFlight
    },
  }
}
