import type { PrismaClient } from '../generated/prisma'
import { AccountStatus, PenaltyStatus } from '../generated/prisma'
import { AlertSink, safeEmit } from '../alerts'
import { claimOutboxBatch } from './outbox-claim'
import type { OutboxWorkerLogger } from './outbox-claim'

/**
 * disputePenaltyWorker — SEUL chemin qui exécute le prélèvement d'une pénalité
 * d'INSTRUCTION (frais fixes 150 € = 15000 c) pour contestation manifestement
 * abusive. Distinct de penalty.worker.ts (ponction de fraude 200% du voyageur).
 *
 * Pattern outbox, règle d'or « aucun appel Stripe dans une transaction DB » :
 *   1. claim par lot (FOR UPDATE SKIP LOCKED, attempts++ committé AVANT Stripe) —
 *      chaque pénalité traitée AU PLUS UNE FOIS par tick (retry au tick suivant) ;
 *   2. HORS tx — charge off-session du moyen de paiement par défaut de l'auteur
 *      (`confirm: true`, `off_session: true`, idempotencyKey `dispute_penalty_<id>`) ;
 *   3. verdict (transaction courte) :
 *        succès → PAID + stripePaymentIntentId ;
 *        échec NON terminal (attempts < max) → reste PENDING (retry, backoff au tick) ;
 *        échec TERMINAL (attempts >= max, OU moyen de paiement absent) → FAILED +
 *          User.accountStatus = SUSPENDED (blacklist auto) + alerte critique.
 *
 * Suspension sur échec TERMINAL seulement (pas sur un decline transitoire isolé) :
 * un timeout réseau ne doit pas blacklister un compte. L'idempotencyKey
 * déterministe rend la charge rejouable sans double prélèvement.
 */

/** Surface Stripe minimale — injectable (fake en test, vrai SDK en prod). */
export interface PenaltyChargeStripeClient {
  paymentIntents: {
    create(
      params: {
        amount: number
        currency: string
        customer?: string
        payment_method: string
        confirm: true
        off_session: true
        metadata: Record<string, string>
      },
      options: { idempotencyKey: string },
    ): Promise<{ id: string; status: string }>
  }
}

export interface DisputePenaltyWorkerDeps {
  prisma: PrismaClient
  stripe: PenaltyChargeStripeClient
  /** Seuil de retries avant FAILED terminal + suspension du compte. */
  maxAttempts?: number
  batchLimit?: number
  log?: OutboxWorkerLogger
  onAlert?: AlertSink
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BATCH_LIMIT = 50

interface ClaimedPenalty {
  id: string
  missionId: string
  userId: string
  amountCents: number
  attempts: number // POST-incrément
  paymentMethodId: string | null
  customerId: string | null
}

/** La charge off-session n'a pas abouti (`status !== 'succeeded'` sans throw). */
class PenaltyChargeNotSucceededError extends Error {}
/** Moyen de paiement par défaut absent : prélèvement impossible (échec terminal). */
class MissingPaymentMethodError extends Error {}

async function claimPenaltyBatch(
  prisma: PrismaClient,
  maxAttempts: number,
  batchLimit: number,
): Promise<ClaimedPenalty[]> {
  return claimOutboxBatch<ClaimedPenalty>(prisma, {
    selectIds: tx => tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Penalty"
      WHERE  "status"   = 'PENDING'
        AND  "attempts" < ${maxAttempts}
      ORDER BY "createdAt"
      LIMIT ${batchLimit}
      FOR UPDATE SKIP LOCKED
    `,
    updateAttempts: (tx, ids) =>
      tx.penalty.updateMany({ where: { id: { in: ids } }, data: { attempts: { increment: 1 } } }),
    fetchClaimed: async (tx, ids) => {
      const rows = await tx.penalty.findMany({
        where: { id: { in: ids } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          missionId: true,
          userId: true,
          amountCents: true,
          attempts: true,
          user: { select: { stripePaymentMethodId: true, stripeCustomerId: true } },
        },
      })
      return rows.map(p => ({
        id: p.id,
        missionId: p.missionId,
        userId: p.userId,
        amountCents: p.amountCents,
        attempts: p.attempts,
        paymentMethodId: p.user.stripePaymentMethodId,
        customerId: p.user.stripeCustomerId,
      }))
    },
  })
}

/**
 * Sweep des pénalités STUCK_PENDING — crash window : attempts a été incrémenté
 * mais le verdict (PAID/FAILED) n'a jamais été commité. Ces pénalités ne peuvent
 * plus être claimées (attempts >= maxAttempts) et resteraient bloquées à vie sans
 * cette remédiation.
 *
 * SÛRETÉ : pas de suspension auto — la charge Stripe a PU aboutir (idempotencyKey
 * déterministe `dispute_penalty_<id>` permet la vérification manuelle). Suspension
 * uniquement si l'impayé est confirmé par l'opérateur.
 * Atomique (FOR UPDATE SKIP LOCKED) : deux instances concurrentes ne remédie pas
 * deux fois la même pénalité. Alerte post-commit avec l'idempotencyKey pour
 * réconciliation immédiate dans le dashboard.
 */
async function sweepStuckPenalties(
  deps: DisputePenaltyWorkerDeps,
  maxAttempts: number,
): Promise<void> {
  const { prisma } = deps
  const log = deps.log ?? console

  const stuck = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<
      Array<{ id: string; missionId: string; userId: string; amountCents: number; attempts: number }>
    >`
      SELECT "id", "missionId", "userId", "amountCents", "attempts"
      FROM   "Penalty"
      WHERE  "status"   = 'PENDING'
        AND  "attempts" >= ${maxAttempts}
      ORDER  BY "createdAt"
      FOR UPDATE SKIP LOCKED
    `
    if (rows.length === 0) return []
    await tx.penalty.updateMany({
      where: { id: { in: rows.map(r => r.id) } },
      data: { status: PenaltyStatus.FAILED, lastError: 'STUCK_PENDING_REAPED' },
    })
    return rows
  })
  if (stuck.length === 0) return

  log.error(
    { worker: 'disputePenaltyWorker', stuckCount: stuck.length, penaltyIds: stuck.map(p => p.id) },
    'dispute-penalty: pénalités STUCK_PENDING remédiées → FAILED (charge Stripe possible — vérifier via idempotencyKey)',
  )
  safeEmit(deps.onAlert, {
    code: 'DISPUTE_PENALTY_STUCK_PENDING',
    message: `${stuck.length} pénalité(s) bloquée(s) PENDING (attempts≥maxAttempts) remédié(s) → FAILED — vérifier charge Stripe avant toute action`,
    details: {
      stuckCount: stuck.length,
      maxAttempts,
      penalties: stuck.map(p => ({
        penaltyId: p.id,
        missionId: p.missionId,
        userId: p.userId,
        amountCents: p.amountCents,
        attempts: p.attempts,
        idempotencyKey: `dispute_penalty_${p.id}`,
      })),
    },
  })
}

/** Verdict d'échec : retry (PENDING) sous le seuil, sinon FAILED + suspension du compte. */
async function failPenalty(
  deps: DisputePenaltyWorkerDeps,
  claimed: ClaimedPenalty,
  maxAttempts: number,
  message: string,
  terminalOverride = false,
): Promise<'failed' | 'suspended'> {
  const { prisma, log } = { ...deps, log: deps.log ?? console }
  const terminal = terminalOverride || claimed.attempts >= maxAttempts

  if (!terminal) {
    await prisma.penalty.update({
      where: { id: claimed.id },
      data: { status: PenaltyStatus.PENDING, lastError: message },
    })
    log.error(
      { worker: 'disputePenaltyWorker', penaltyId: claimed.id, missionId: claimed.missionId, attempt: claimed.attempts, maxAttempts, err: message },
      'dispute-penalty: échec prélèvement — retry planifié',
    )
    return 'failed'
  }

  // Échec terminal : FAILED + blacklist auto du compte + audit SYSTÈME, ATOMIQUEMENT.
  await prisma.$transaction(async tx => {
    await tx.penalty.update({
      where: { id: claimed.id },
      data: { status: PenaltyStatus.FAILED, lastError: message },
    })
    await tx.user.update({
      where: { id: claimed.userId },
      data: { accountStatus: AccountStatus.SUSPENDED },
    })
    await tx.adminAuditLog.createMany({
      data: [
        { actor: 'SYSTEM', adminId: null, action: 'INSTRUCTION_PENALTY_FAILED', missionId: claimed.missionId },
        { actor: 'SYSTEM', adminId: null, action: 'ACCOUNT_SUSPENDED', missionId: claimed.missionId },
      ],
    })
  })
  log.error(
    { worker: 'disputePenaltyWorker', penaltyId: claimed.id, missionId: claimed.missionId, userId: claimed.userId, err: message },
    'dispute-penalty: prélèvement ABANDONNÉ — compte suspendu (blacklist auto)',
  )
  safeEmit(deps.onAlert, {
    code: 'DISPUTE_PENALTY_ACCOUNT_SUSPENDED',
    message: 'Prélèvement de pénalité d\'instruction échoué définitivement — compte suspendu automatiquement',
    details: { penaltyId: claimed.id, missionId: claimed.missionId, userId: claimed.userId, amountCents: claimed.amountCents, lastError: message },
  })
  return 'suspended'
}

/** Exécute le prélèvement d'une pénalité claimée. Renvoie 'paid' | 'failed' | 'suspended'. */
async function chargePenalty(
  deps: DisputePenaltyWorkerDeps,
  claimed: ClaimedPenalty,
  maxAttempts: number,
): Promise<'paid' | 'failed' | 'suspended'> {
  const { prisma, stripe, log } = { ...deps, log: deps.log ?? console }
  try {
    // Moyen de paiement par défaut absent = prélèvement impossible → échec TERMINAL
    // (suspension immédiate, inutile de retenter une charge sans carte).
    if (!claimed.paymentMethodId) {
      throw new MissingPaymentMethodError('DEFAULT_PAYMENT_METHOD_MISSING')
    }
    // Charge off-session HORS tx — idempotencyKey déterministe (dispute_penalty_<id>) :
    // un rejeu (retry, crash après charge) renvoie le MÊME PI, jamais de double débit.
    const intent = await stripe.paymentIntents.create(
      {
        amount: claimed.amountCents,
        currency: 'eur',
        ...(claimed.customerId ? { customer: claimed.customerId } : {}),
        payment_method: claimed.paymentMethodId,
        confirm: true,
        off_session: true,
        metadata: { missionId: claimed.missionId, kind: 'dispute_instruction_penalty' },
      },
      { idempotencyKey: `dispute_penalty_${claimed.id}` },
    )
    // off_session abouti = 'succeeded' ; tout autre statut (requires_action : 3DS hors
    // session impossible) est un échec → backoff (jamais un faux PAID).
    if (intent.status !== 'succeeded') {
      throw new PenaltyChargeNotSucceededError(`PENALTY_CHARGE_NOT_SUCCEEDED:${intent.status}`)
    }

    await prisma.$transaction(async tx => {
      await tx.penalty.update({
        where: { id: claimed.id },
        data: { status: PenaltyStatus.PAID, stripePaymentIntentId: intent.id, lastError: null },
      })
      await tx.adminAuditLog.create({
        data: { actor: 'SYSTEM', adminId: null, action: 'INSTRUCTION_PENALTY_CHARGED', missionId: claimed.missionId },
      })
    })
    log.info(
      { worker: 'disputePenaltyWorker', penaltyId: claimed.id, missionId: claimed.missionId, amountCents: claimed.amountCents, stripePaymentIntentId: intent.id },
      'dispute-penalty: prélèvement Stripe réussi — pénalité réglée',
    )
    return 'paid'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Carte absente = échec terminal immédiat (pas de retry possible sans moyen de paiement).
    const terminalOverride = err instanceof MissingPaymentMethodError
    return failPenalty(deps, claimed, maxAttempts, message, terminalOverride)
  }
}

/** Un passage du worker (un tick cron). Idempotent, relançable à volonté. */
export async function runDisputePenaltyWorkerOnce(
  deps: DisputePenaltyWorkerDeps,
): Promise<{ paid: number; failed: number; suspended: number }> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT

  // Sweep préventif : pénalités STUCK_PENDING (crash window) → FAILED + alerte.
  // Exécuté AVANT le claim normal pour qu'elles ne polluent pas le batch suivant.
  await sweepStuckPenalties(deps, maxAttempts)

  let paid = 0
  let failed = 0
  let suspended = 0

  const batch = await claimPenaltyBatch(deps.prisma, maxAttempts, batchLimit)
  for (const claimed of batch) {
    const outcome = await chargePenalty(deps, claimed, maxAttempts)
    if (outcome === 'paid') paid += 1
    else if (outcome === 'suspended') suspended += 1
    else failed += 1
  }

  return { paid, failed, suspended }
}

/**
 * Boucle cron (~1 min par défaut) — miroir des autres workers outbox. Garde
 * `inFlight` + `.catch` de tick ; la concurrence multi-instance reste couverte
 * par le `FOR UPDATE SKIP LOCKED` du claim.
 */
export function startDisputePenaltyWorkerLoop(
  deps: DisputePenaltyWorkerDeps,
  intervalMs = 60_000,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return
    inFlight = true
    void runDisputePenaltyWorkerOnce(deps)
      .catch(err => (deps.log ?? console).error({ err: String(err) }, 'dispute penalty worker tick failed'))
      .finally(() => {
        inFlight = false
      })
  }, intervalMs)
}
