import type { PrismaClient } from '../generated/prisma'
import type { PaymentIntentClient } from '../missions/mission-common'
import { captureEscrowFunds, EscrowCaptureError } from '../services/escrowService'

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
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "OutboxEvent"
      WHERE  "type"     = 'READY_FOR_PAYOUT'
        AND  "status"   = 'PENDING'
        AND  "attempts" < ${maxAttempts}
      ORDER BY "createdAt"
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

    try {
      // HORS transaction DB — règle « No Stripe in DB tx ».
      // idempotencyKey `capture_<missionId>` par défaut dans captureEscrowFunds :
      // un rejeu (crash entre claim et verdict) appelle le MÊME PI → aucun double débit.
      const result = await captureEscrowFunds(claimed.missionId, stripe)

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
        },
        'escrow: capture Stripe réussie — payout voyageur déclenché',
      )
      settled++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Seuil max atteint → FAILED terminal (hors queue, intervention manuelle).
      // Sous le seuil → PENDING (retry au prochain tick, attempts déjà incrémenté).
      const isTerminal = claimed.attempts >= maxAttempts

      await prisma.outboxEvent.update({
        where: { id: claimed.id },
        data: { status: isTerminal ? 'FAILED' : 'PENDING', lastError: message },
      })

      log.error(
        {
          outboxEventId: claimed.id,
          missionId: claimed.missionId,
          attempt: claimed.attempts,
          maxAttempts,
          isEscrowError: err instanceof EscrowCaptureError,
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
