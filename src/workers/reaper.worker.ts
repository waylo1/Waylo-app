import type { PrismaClient } from '../generated/prisma'
import { PenaltyStatus } from '../generated/prisma'
import type { AlertSink } from '../alerts'
import { safeEmit } from '../alerts'
import type { OutboxWorkerLogger } from './outbox-claim'

/**
 * Reaper worker — surveillance des pénalités STUCK_PENDING.
 *
 * Une pénalité PENDING avec attempts≥maxAttempts signale un crash entre le
 * commit de `attempts++` (claim) et le commit du verdict (PAID/FAILED). Ces
 * lignes ne peuvent plus être claimées par le worker normal (`attempts < max`) :
 * elles seraient bloquées à vie sans remédiation.
 *
 * Ce worker est un moniteur de DÉTECTION : il compte et alerte. La remédiation
 * (transition → FAILED) est faite par le sweep intégré dans `disputePenaltyWorker`
 * (`sweepStuckPenalties`, au début de chaque tick du worker).
 *
 * L'alerte inclut l'`idempotencyKey` Stripe (`dispute_penalty_<id>`) pour
 * permettre la réconciliation immédiate dans le dashboard : vérifier si la
 * charge a abouti AVANT toute action manuelle (suspension, re-prélèvement).
 */

export interface ReaperWorkerDeps {
  prisma: PrismaClient
  /** Doit correspondre au maxAttempts du disputePenaltyWorker. */
  maxAttempts?: number
  onAlert?: AlertSink
  log?: OutboxWorkerLogger
}

const DEFAULT_MAX_ATTEMPTS = 3

/** Un passage du reaper (un tick cron). Renvoie le nombre de pénalités bloquées détectées. */
export async function runReaperOnce(deps: ReaperWorkerDeps): Promise<{ stuckCount: number }> {
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const log = deps.log ?? console

  const stuck = await deps.prisma.penalty.findMany({
    where: { status: PenaltyStatus.PENDING, attempts: { gte: maxAttempts } },
    select: { id: true, missionId: true, userId: true, amountCents: true, attempts: true },
  })

  if (stuck.length === 0) return { stuckCount: 0 }

  log.error(
    { worker: 'reaper', stuckCount: stuck.length, penaltyIds: stuck.map(p => p.id) },
    'reaper: pénalités STUCK_PENDING détectées — sweep du disputePenaltyWorker requis',
  )
  safeEmit(deps.onAlert, {
    code: 'DISPUTE_PENALTY_STUCK_PENDING',
    message: `${stuck.length} pénalité(s) bloquée(s) PENDING avec attempts≥maxAttempts — vérifier charge Stripe avant toute action`,
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

  return { stuckCount: stuck.length }
}

/**
 * Boucle cron du reaper (5 min par défaut — moins fréquent que le worker 1 min).
 * Garde `inFlight` : un tick lent ne lance pas un second.
 */
export function startReaperLoop(
  deps: ReaperWorkerDeps,
  intervalMs = 5 * 60_000,
): NodeJS.Timeout {
  let inFlight = false
  return setInterval(() => {
    if (inFlight) return
    inFlight = true
    void runReaperOnce(deps)
      .catch(err => (deps.log ?? console).error({ err: String(err) }, 'reaper tick failed'))
      .finally(() => { inFlight = false })
  }, intervalMs)
}
