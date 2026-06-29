import type { PrismaClient } from '../generated/prisma'
import { EscrowStatus, MissionStatus, OutboxEventType } from '../generated/prisma'
import type { PaymentIntentClient } from '../missions/mission-common'
import { claimOutboxBatch } from './outbox-claim'
import type { OutboxWorkerLogger } from './outbox-claim'

/**
 * DisputeResolutionWorker (litige AUTOMATISÉ) — résout les litiges `IN_DISPUTE`
 * dont la `disputeDeadline` (now + 72 h) est dépassée, SANS intervention humaine.
 *
 * Deux phases par tick, toutes deux respectant la règle d'or « aucun appel Stripe
 * dans une transaction DB » :
 *
 *   1. ENQUEUE (transactionnel, zéro réseau) — scan des missions `IN_DISPUTE` à
 *      échéance dépassée encore SANS event de refund ; insère un OutboxEvent
 *      READY_FOR_REFUND par mission. `FOR UPDATE SKIP LOCKED` + `NOT EXISTS` :
 *      idempotent et sûr en multi-instance (aucun doublon d'intention de refund).
 *
 *   2. CONSUME (claim → Stripe hors tx → verdict) — miroir de escrowPayoutWorker :
 *      • claim atomique d'un READY_FOR_REFUND PENDING (FOR UPDATE SKIP LOCKED,
 *        attempts++ committé AVANT l'appel Stripe → backoff naturel au crash) ;
 *      • `paymentIntents.cancel` HORS transaction (annule le hold non capturé =
 *        REFUND dans le modèle escrow à capture différée), idempotencyKey
 *        déterministe `dispute_refund_<missionId>` ;
 *      • verdict (transaction courte) : outbox SETTLED + mission IN_DISPUTE →
 *        REFUNDED + escrow HELD → CANCELLED. La mission reste IN_DISPUTE tant que
 *        le refund n'a pas abouti → la garde escrowPayoutWorker continue de bloquer
 *        tout payout pendant la fenêtre de remboursement (pas de double décaissement).
 *
 * Le résultat de chaque refund est LOGUÉ (succès = log.info, échec = log.error).
 */

export interface DisputeResolutionWorkerDeps {
  prisma: PrismaClient
  stripe: PaymentIntentClient
  maxAttempts?: number
  batchLimit?: number
  log?: OutboxWorkerLogger
  /** Horloge injectable (tests) — défaut : maintenant. */
  now?: Date
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BATCH_LIMIT = 50

// [WATCHDOG] verifyAbuse et la branche pénalité d'instruction ont été retirés :
// le timeout auto-refund (triggerAutoRefundWatchdog) n'est pas une contestation
// initiée par l'acheteur — la sémantique ABUSIVE_CONTESTATION ne s'applique pas ici.

interface ClaimedRefund {
  id: string
  missionId: string
  attempts: number // valeur POST-incrément : 1 au premier essai
}

/**
 * Phase ENQUEUE — enfile un OutboxEvent READY_FOR_REFUND par mission `IN_DISPUTE`
 * à échéance dépassée n'en ayant pas déjà un. `FOR UPDATE SKIP LOCKED` sérialise
 * les instances concurrentes ; `NOT EXISTS` rend l'opération idempotente (pas de
 * double intention de refund). Renvoie le nombre d'events créés.
 */
async function enqueueExpiredDisputeRefunds(
  prisma: PrismaClient,
  batchLimit: number,
  now: Date,
): Promise<number> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT m."id" FROM "Mission" m
      WHERE  m."status"          = 'IN_DISPUTE'
        AND  m."disputeDeadline" IS NOT NULL
        AND  m."disputeDeadline" < ${now}
        AND  NOT EXISTS (
          SELECT 1 FROM "OutboxEvent" o
          WHERE o."missionId" = m."id" AND o."type" = 'READY_FOR_REFUND'
        )
      ORDER BY m."disputeDeadline"
      LIMIT ${batchLimit}
      FOR UPDATE SKIP LOCKED
    `
    if (rows.length === 0) return 0
    await tx.outboxEvent.createMany({
      data: rows.map(r => ({
        missionId: r.id,
        type: OutboxEventType.READY_FOR_REFUND,
        payload: { reason: 'DISPUTE_DEADLINE_REACHED' },
      })),
    })
    return rows.length
  })
}

async function claimRefundBatch(
  prisma: PrismaClient,
  maxAttempts: number,
  batchLimit: number,
): Promise<ClaimedRefund[]> {
  return claimOutboxBatch<ClaimedRefund>(prisma, {
    selectIds: tx => tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "OutboxEvent"
      WHERE  "type"     = 'READY_FOR_REFUND'
        AND  "status"   = 'PENDING'
        AND  "attempts" < ${maxAttempts}
      ORDER BY "createdAt"
      LIMIT ${batchLimit}
      FOR UPDATE SKIP LOCKED
    `,
    updateAttempts: (tx, ids) =>
      tx.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 } } }),
    fetchClaimed: (tx, ids) =>
      tx.outboxEvent.findMany({
        where: { id: { in: ids } },
        select: { id: true, missionId: true, attempts: true },
        orderBy: { createdAt: 'asc' },
      }),
  })
}

/** Verdict d'échec : retry (PENDING) sous le seuil, FAILED terminal au seuil. */
async function failRefund(
  prisma: PrismaClient,
  claimed: ClaimedRefund,
  maxAttempts: number,
  log: OutboxWorkerLogger,
  message: string,
  terminal: boolean,
): Promise<'failed'> {
  await prisma.outboxEvent.update({
    where: { id: claimed.id },
    data: { status: terminal ? 'FAILED' : 'PENDING', lastError: message },
  })
  log.error(
    {
      kind: 'WORKER_ERROR',
      worker: 'disputeResolutionWorker',
      outboxEventId: claimed.id,
      missionId: claimed.missionId,
      attempt: claimed.attempts,
      maxAttempts,
      err: message,
    },
    terminal
      ? 'dispute: refund ABANDONNÉ après seuil max — intervention requise'
      : 'dispute: échec refund Stripe — retry planifié',
  )
  return 'failed'
}

/** Exécute le refund d'un event claimé. Renvoie 'refunded' | 'failed' (observabilité). */
async function executeRefund(
  prisma: PrismaClient,
  stripe: PaymentIntentClient,
  claimed: ClaimedRefund,
  maxAttempts: number,
  log: OutboxWorkerLogger,
): Promise<'refunded' | 'failed'> {
  const escrow = await prisma.escrowTransaction.findUnique({
    where: { missionId: claimed.missionId },
    select: { id: true, stripePaymentIntentId: true, status: true },
  })

  // Fonds déjà capturés/libérés : un refund par annulation du hold est impossible
  // (nécessiterait refunds.create — hors périmètre). Terminal, journalisé.
  if (
    escrow &&
    (escrow.status === EscrowStatus.RELEASED || escrow.status === EscrowStatus.PARTIALLY_REFUNDED)
  ) {
    return failRefund(prisma, claimed, maxAttempts, log, `ESCROW_NOT_CANCELLABLE:${escrow.status}`, true)
  }

  const startedAt = Date.now()
  try {
    // Annulation Stripe HORS transaction — uniquement si le hold est encore actif.
    // Un escrow déjà CANCELLED/REFUNDED (rejeu, refund concurrent) : pas d'appel
    // Stripe, on finalise idempotemment l'état DB ci-dessous.
    if (escrow && escrow.status === EscrowStatus.HELD) {
      if (!stripe.paymentIntents.cancel) throw new Error('REFUND_UNAVAILABLE')
      // idempotencyKey déterministe par mission : un rejeu post-crash annule le
      // MÊME PaymentIntent une seule fois.
      await stripe.paymentIntents.cancel(
        escrow.stripePaymentIntentId,
        {},
        { idempotencyKey: `dispute_refund_${claimed.missionId}` },
      )
    }
    const refundDurationMs = Date.now() - startedAt

    // Verdict : transaction courte, aucun appel Stripe.
    await prisma.$transaction(async tx => {
      await tx.outboxEvent.update({
        where: { id: claimed.id },
        data: { status: 'SETTLED', lastError: null },
      })
      // Anti-TOCTOU : la mission ne quitte IN_DISPUTE → REFUNDED qu'ICI, après refund
      // confirmé.
      await tx.mission.updateMany({
        where: { id: claimed.missionId, status: MissionStatus.IN_DISPUTE },
        data: { status: MissionStatus.REFUNDED },
      })
      // Hold non capturé annulé → escrow CANCELLED (filtré sur HELD : idempotent).
      if (escrow) {
        await tx.escrowTransaction.updateMany({
          where: { id: escrow.id, status: EscrowStatus.HELD },
          data: { status: EscrowStatus.CANCELLED },
        })
      }
    })

    log.info(
      {
        outboxEventId: claimed.id,
        missionId: claimed.missionId,
        stripePaymentIntentId: escrow?.stripePaymentIntentId ?? null,
        escrowStatusBefore: escrow?.status ?? null,
        refundDurationMs,
      },
      'dispute: refund Stripe exécuté — mission remboursée',
    )
    return 'refunded'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Seuil atteint → FAILED terminal ; sinon PENDING (retry, attempts déjà incrémenté).
    return failRefund(prisma, claimed, maxAttempts, log, message, claimed.attempts >= maxAttempts)
  }
}

/** Un passage du worker (un tick cron). Idempotent, relançable à volonté. */
export async function runDisputeResolutionWorkerOnce(
  deps: DisputeResolutionWorkerDeps,
): Promise<{ enqueued: number; refunded: number; failed: number }> {
  const { prisma, stripe } = deps
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT
  const log = deps.log ?? console
  const now = deps.now ?? new Date()

  // Phase 1 — enfile les intentions de refund (échéances dépassées).
  const enqueued = await enqueueExpiredDisputeRefunds(prisma, batchLimit, now)

  // Phase 2 — draine la file READY_FOR_REFUND (claim par lot : chaque event traité
  // au plus une fois par tick, retry au tick suivant).
  let refunded = 0
  let failed = 0
  const batch = await claimRefundBatch(prisma, maxAttempts, batchLimit)
  for (const claimed of batch) {
    const outcome = await executeRefund(prisma, stripe, claimed, maxAttempts, log)
    if (outcome === 'refunded') refunded++
    else failed++
  }

  return { enqueued, refunded, failed }
}

/**
 * Boucle cron (~1 min par défaut) — miroir des autres workers outbox. Garde
 * `inFlight` (jamais deux passages concurrents dans CE process) + `.catch` de tick
 * (une panne DB n'effondre pas le scheduler : le prochain tick reprend). La
 * concurrence MULTI-instance reste couverte par les `FOR UPDATE SKIP LOCKED`.
 */
export function startDisputeResolutionWorkerLoop(
  deps: DisputeResolutionWorkerDeps,
  intervalMs = 60_000,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return // passage précédent encore en cours — tick sauté
    inFlight = true
    void runDisputeResolutionWorkerOnce(deps)
      .catch(err => (deps.log ?? console).error({ err: String(err) }, 'dispute resolution worker tick failed'))
      .finally(() => {
        inFlight = false
      })
  }, intervalMs)
}
