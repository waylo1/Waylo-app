import type { PrismaClient } from '../generated/prisma'
import { MissionStatus } from '../generated/prisma'
import type { PaymentIntentClient } from '../missions/mission-common'
import { captureEscrowFunds, EscrowCaptureError } from '../services/escrowService'
import { runAlias, WatchdogExhaustedError } from '@waylo/shared/automation'

/**
 * Worker de PAYOUT ESCROW (S22) — consomme les OutboxEvent READY_FOR_PAYOUT
 * créés par `confirmReception` et exécute la capture Stripe.
 *
 * Règle d'or strictement respectée : AUCUN appel Stripe dans une transaction DB.
 *   1. Claim atomique (FOR UPDATE SKIP LOCKED) : incrémente `attempts` dans une
 *      transaction courte → commit avant tout appel réseau.
 *   2. `captureEscrowFunds` HORS tx — idempotente via clé `capture_<missionId>` :
 *      un rejeu (crash entre 1 et 3) ne crée jamais un double débit.
 *   3. Verdict (transaction courte) : PENDING → SETTLED | FAILED.
 *
 * Idempotence :
 *   - `FOR UPDATE SKIP LOCKED` : deux instances ne traitent pas le même event
 *     dans le même tick.
 *   - Idempotency key Stripe déterministe : un retry après crash est sans danger.
 *   - Guard `attempts < maxAttempts` : un event FAILED (terminal) n'est plus sélectionné.
 *
 * Erreurs déterministes (ESCROW_NOT_FOUND, ESCROW_NOT_HELD, ESCROW_NOT_HELD) :
 * pas de classe séparée — elles épuisent le quota maxAttempts et passent FAILED
 * définitif, avec log.error pour intervention manuelle.
 */

export interface PayoutWorkerLogger {
  info(data: Record<string, unknown>, msg: string): void
  error(data: Record<string, unknown>, msg: string): void
}

export interface EscrowPayoutWorkerDeps {
  prisma: PrismaClient
  stripe: PaymentIntentClient
  maxAttempts?: number
  batchLimit?: number
  log?: PayoutWorkerLogger
}

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BATCH_LIMIT = 50

interface ClaimedEvent {
  id: string
  missionId: string
  attempts: number // valeur POST-incrément : 1 au premier essai
}

/**
 * Sélectionne et verrouille le prochain OutboxEvent READY_FOR_PAYOUT éligible.
 * La transaction incrémente `attempts` AVANT l'appel Stripe — si le process
 * crash entre le claim et le verdict, le compteur est déjà avancé (backoff naturel).
 */
async function claimNext(prisma: PrismaClient, maxAttempts: number): Promise<ClaimedEvent | null> {
  return prisma.$transaction(async tx => {
    // Garde litige (exclusion au claim) : un event dont la mission est IN_DISPUTE
    // n'est JAMAIS sélectionné → aucun payout, aucun `attempts` brûlé, aucune
    // famine (les events payables restent éligibles). Le refund auto suivra son
    // propre chemin (DisputeResolutionWorker). Défense complétée par la garde JS
    // ci-dessous pour la course « litige ouvert APRÈS le claim ».
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT o."id" FROM "OutboxEvent" o
      WHERE  o."type"     = 'READY_FOR_PAYOUT'
        AND  o."status"   = 'PENDING'
        AND  o."attempts" < ${maxAttempts}
        AND  NOT EXISTS (
          SELECT 1 FROM "Mission" m
          WHERE m."id" = o."missionId" AND m."status" = 'IN_DISPUTE'
        )
      ORDER BY o."createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `
    const candidate = rows[0]
    if (!candidate) return null

    const claimed = await tx.outboxEvent.update({
      where: { id: candidate.id },
      data: { attempts: { increment: 1 } },
      select: { id: true, missionId: true, attempts: true },
    })
    return claimed
  })
}

/** Un passage du worker (un tick cron). Idempotent, relançable à volonté. */
export async function runEscrowPayoutWorkerOnce(
  deps: EscrowPayoutWorkerDeps,
): Promise<{ settled: number; failed: number }> {
  const { prisma, stripe } = deps
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT
  const log = deps.log ?? console

  let settled = 0
  let failed = 0

  for (let i = 0; i < batchLimit; i++) {
    const claimed = await claimNext(prisma, maxAttempts)
    if (!claimed) break

    // Garde litige (course claim/check) : si la mission est passée IN_DISPUTE entre
    // le claim et ici, on NE paie PAS. On relâche l'event en PENDING sans pénaliser
    // le compteur (decrement de l'incrément du claim) ; le claim SQL l'exclura aux
    // prochains ticks tant que le litige dure. Le refund auto est porté par
    // DisputeResolutionWorker.
    const mission = await prisma.mission.findUnique({
      where: { id: claimed.missionId },
      select: { status: true },
    })
    if (mission?.status === MissionStatus.IN_DISPUTE) {
      await prisma.outboxEvent.update({
        where: { id: claimed.id },
        data: { status: 'PENDING', attempts: { decrement: 1 }, lastError: 'BLOCKED_IN_DISPUTE' },
      })
      log.info(
        { outboxEventId: claimed.id, missionId: claimed.missionId },
        'escrow: payout bloqué — mission en litige (IN_DISPUTE)',
      )
      continue
    }

    // Chrono de la capture Stripe — déclaré hors du try pour être mesuré aussi en cas d'erreur.
    const startedAt = Date.now()
    try {
      // HORS transaction DB — règle « No Stripe in DB tx ».
      // runAlias 'stripe-capture' : retry exponentiel (3 essais max, backoff 500ms)
      // pour les erreurs réseau transitoires. idempotencyKey = missionId → rejeu sûr.
      const result = await runAlias(
        'stripe-capture',
        () => captureEscrowFunds(claimed.missionId, stripe),
        {
          idempotencyKey: claimed.missionId,
          onLog: entry => {
            if (entry.event === 'attempt_failure') {
              log.error(
                {
                  kind: 'STRIPE_CAPTURE_RETRY',
                  missionId: claimed.missionId,
                  attempt: entry.attempt,
                  maxRetries: entry.maxRetries,
                  error: entry.error,
                },
                `escrow: tentative capture ${entry.attempt}/${entry.maxRetries} échouée — retry watchdog`,
              )
            }
          },
        },
      )
      const captureDurationMs = Date.now() - startedAt

      // Verdict succès : transaction courte, aucun appel Stripe.
      await prisma.outboxEvent.update({
        where: { id: claimed.id },
        data: { status: 'SETTLED', lastError: null },
      })

      // Audit structuré (log.info) — le worker n'a pas d'acteur humain ; l'audit
      // financier formel est porté par la LedgerEntry CAPTURE créée par le webhook
      // payment_intent.succeeded à réception.
      log.info(
        {
          outboxEventId: claimed.id,
          missionId: claimed.missionId,
          capturedAmountCents: result.capturedAmountCents,
          stripePaymentIntentId: result.stripePaymentIntentId,
          captureDurationMs, // métrique de latence Stripe par capture
        },
        'escrow: capture Stripe réussie — payout voyageur déclenché',
      )
      settled++
    } catch (err) {
      const captureDurationMs = Date.now() - startedAt
      // Déballer WatchdogExhaustedError pour exposer l'erreur racine dans les logs.
      const underlying = err instanceof WatchdogExhaustedError ? err.cause : err
      const message = underlying instanceof Error ? underlying.message : String(underlying)
      // Seuil max atteint → FAILED terminal (hors queue, intervention manuelle).
      // Sous le seuil → PENDING (retry au prochain tick, attempts déjà incrémenté).
      const isTerminal = claimed.attempts >= maxAttempts

      await prisma.outboxEvent.update({
        where: { id: claimed.id },
        data: { status: isTerminal ? 'FAILED' : 'PENDING', lastError: message },
      })

      // Log structuré WORKER_ERROR : exception captureEscrowFunds non aboutie —
      // exploitable par l'agrégation de logs / alerting (kind dédié).
      log.error(
        {
          kind: 'WORKER_ERROR',
          worker: 'escrowPayoutWorker',
          outboxEventId: claimed.id,
          missionId: claimed.missionId,
          attempt: claimed.attempts,
          maxAttempts,
          isEscrowError: underlying instanceof EscrowCaptureError,
          isExhausted: err instanceof WatchdogExhaustedError,
          captureDurationMs,
          err: message,
        },
        isTerminal
          ? 'escrow: capture ABANDONNÉE après seuil max — intervention manuelle requise'
          : 'escrow: échec capture Stripe — retry planifié',
      )
      failed++
    }
  }

  return { settled, failed }
}

/**
 * Boucle cron (intervalle 60 s par défaut) — miroir exact des autres workers
 * outbox. L'inFlight guard est géré par le `FOR UPDATE SKIP LOCKED` : deux
 * ticks concurrents dans le MÊME process ne traitent pas le même event.
 * Retourne le timer pour clearInterval propre au shutdown.
 */
export function startEscrowPayoutWorkerLoop(
  deps: EscrowPayoutWorkerDeps,
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    void runEscrowPayoutWorkerOnce(deps).catch(err =>
      (deps.log ?? console).error({ err }, 'escrow payout worker tick failed'),
    )
  }, intervalMs)
}
