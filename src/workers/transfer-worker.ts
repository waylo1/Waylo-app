import type { PrismaClient } from '../generated/prisma'
import { TransferStatus } from '../generated/prisma'
import { AlertSink, safeEmit } from '../alerts'

/**
 * Worker de transfert Connect — SEUL chemin du code qui exécute un versement.
 *
 * Pattern outbox : le webhook commit l'intention (TransferOutbox PENDING) avec
 * la ligne PAYOUT ; ce worker la matérialise côté Stripe. Aucun appel Stripe
 * n'a lieu dans une transaction DB :
 *   1. claim (transaction courte) : SELECT ... FOR UPDATE SKIP LOCKED → SUBMITTED, commit ;
 *   2. stripe.transfers.create HORS transaction, avec l'idempotencyKey de la ligne ;
 *   3. update SETTLED + stripeTransferId, ou FAILED + lastError + attempts++.
 *
 * Idempotent par construction : l'idempotencyKey Stripe rend create rejouable
 * (même clé → même transfert), le statut DB empêche la re-sélection. Un crash
 * entre 1 et 3 laisse la ligne SUBMITTED : elle redevient éligible après
 * STALE_SUBMITTED_MINUTES et le rejeu est sans danger grâce à l'idempotencyKey.
 */

/** Surface Stripe minimale — injectable (fake en test, vrai client en prod). */
export interface TransferClient {
  transfers: {
    create(
      params: { amount: number; currency: string; destination: string },
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
}

/** Logger structuré minimal — compatible pino (Fastify) et console. */
export interface WorkerLogger {
  error(details: Record<string, unknown>, message?: string): void
}

export interface TransferWorkerDeps {
  prisma: PrismaClient
  stripe: TransferClient
  /**
   * M : seuil d'abandon. Au M-ième échec la ligne passe en ABANDONED
   * (terminal — hors scope worker ET requeue) avec UNE alerte
   * TRANSFER_ABANDONED « needs human », émise à la transition uniquement.
   */
  maxAttempts?: number
  /** Bornage d'un passage de cron — le reliquat part au tick suivant. */
  batchLimit?: number
  log?: WorkerLogger
  /** Hook d'alerte (cf. src/alerts.ts). */
  onAlert?: AlertSink
}

const STALE_SUBMITTED_MINUTES = 15
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_BATCH_LIMIT = 50

interface ClaimedTransfer {
  id: string
  amountCents: number
  destinationAccountId: string
  idempotencyKey: string
  attempts: number
}

/**
 * Réserve la prochaine ligne éligible. FOR UPDATE SKIP LOCKED : deux instances
 * du worker ne peuvent pas réserver la même ligne ; la transition vers
 * SUBMITTED commit AVANT tout appel Stripe.
 * Backoff exponentiel des FAILED : éligible quand updatedAt < now − 2^attempts minutes.
 */
async function claimNext(
  prisma: PrismaClient,
  maxAttempts: number,
): Promise<ClaimedTransfer | null> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "TransferOutbox"
      WHERE (
        "status" = 'PENDING'
        OR ("status" = 'FAILED' AND "attempts" < ${maxAttempts}
            AND "updatedAt" < now() - make_interval(secs => 60 * pow(2, "attempts")))
        OR ("status" = 'SUBMITTED'
            AND "updatedAt" < now() - make_interval(secs => ${STALE_SUBMITTED_MINUTES * 60}))
      )
      ORDER BY "createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `
    const candidate = rows[0]
    if (!candidate) return null

    const claimed = await tx.transferOutbox.update({
      where: { id: candidate.id },
      data: { status: TransferStatus.SUBMITTED },
      select: {
        id: true,
        amountCents: true,
        destinationAccountId: true,
        idempotencyKey: true,
        attempts: true,
      },
    })
    return claimed
  })
}

/** Un passage du worker (un tick de cron). Relançable à volonté. */
export async function runTransferWorkerOnce(
  deps: TransferWorkerDeps,
): Promise<{ settled: number; failed: number; abandoned: number }> {
  const { prisma, stripe } = deps
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT
  const log = deps.log ?? console

  let settled = 0
  let failed = 0
  let abandoned = 0

  for (let i = 0; i < batchLimit; i++) {
    const claimed = await claimNext(prisma, maxAttempts)
    if (!claimed) break

    try {
      // HORS transaction DB — l'idempotencyKey DÉTERMINISTE de la ligne
      // (transfer_marchand_<missionId>, posée à la création par le webhook)
      // garantit qu'un rejeu (retry, ligne SUBMITTED réclamée après crash) ne
      // crée pas de second versement : Stripe renvoie le transfert existant.
      // On réutilise la clé PERSISTÉE — jamais recalculée ici (le recalcul
      // briserait la garantie sur les lignes déjà soumises).
      const transfer = await stripe.transfers.create(
        {
          amount: claimed.amountCents,
          currency: 'eur',
          destination: claimed.destinationAccountId,
        },
        { idempotencyKey: claimed.idempotencyKey },
      )
      await prisma.transferOutbox.update({
        where: { id: claimed.id },
        data: { status: TransferStatus.SETTLED, stripeTransferId: transfer.id },
      })
      settled += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // M-ième échec → ABANDONED : terminal (échec structurel : compte fermé,
      // destination invalide…), sort du scope du worker et du requeue.
      const isAbandon = claimed.attempts + 1 >= maxAttempts
      await prisma.transferOutbox.update({
        where: { id: claimed.id },
        data: {
          status: isAbandon ? TransferStatus.ABANDONED : TransferStatus.FAILED,
          lastError: message,
          attempts: { increment: 1 }, // backoff : ré-éligible après 2^attempts minutes
        },
      })
      if (isAbandon) {
        abandoned += 1
        // Alerte « needs human » UNE SEULE FOIS — à la transition, pas en
        // cycle quotidien (la réconciliation n'alerte pas sur ABANDONED ;
        // l'écart financier reste visible via PAYOUT_NOT_SETTLED).
        safeEmit(deps.onAlert, {
          code: 'TRANSFER_ABANDONED',
          message: `Transfert abandonné après ${claimed.attempts + 1} tentatives — intervention humaine requise`,
          details: {
            outboxId: claimed.id,
            destinationAccountId: claimed.destinationAccountId,
            amountCents: claimed.amountCents,
            lastError: message,
          },
        })
      } else {
        failed += 1
      }
      log.error({ outboxId: claimed.id, err: message }, 'transfer outbox: création échouée')
    }
  }

  return { settled, failed, abandoned }
}

/**
 * Boucle cron explicite (~1 min) — pas un timer caché : c'est LE mécanisme
 * documenté d'exécution des versements (cf. .claude/workflows).
 */
export function startTransferWorkerLoop(
  deps: TransferWorkerDeps,
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    void runTransferWorkerOnce(deps).catch(err =>
      (deps.log ?? console).error({ err }, 'transfer worker tick failed'),
    )
  }, intervalMs)
}
