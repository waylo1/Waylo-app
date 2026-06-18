import type { PrismaClient } from '../generated/prisma'
import { EscrowStatus, TransferStatus } from '../generated/prisma'
import { AlertSink, safeEmit } from '../alerts'
import type { WorkerLogger } from './transfer-worker'

/**
 * Worker de PONCTION DE PÉNALITÉ (fraude/vol voyageur, Sprint 15) — SEUL chemin
 * du code qui exécute le débit de la carte de garantie du voyageur.
 *
 * Pattern outbox, miroir strict de transfer-worker : l'arbitrage admin
 * (`/arbitrate-fraud`, Sprint 14) commit l'intention (`PenaltyDebitOutbox`
 * PENDING) AVEC le ledger 200%/120% ; ce worker la matérialise côté Stripe.
 * Aucun appel Stripe dans une transaction DB (règle d'or) :
 *   1. claim (transaction courte) : SELECT … FOR UPDATE SKIP LOCKED → SUBMITTED, commit ;
 *   2. HORS tx — charge off-session 200% de la carte voyageur
 *      (`confirm: true`, `off_session: true`, idempotencyKey `penalty_debit_<id>`) ;
 *   3. HORS tx — sur succès UNIQUEMENT : annule le hold HELD de l'acheteur
 *      (`paymentIntents.cancel`, clé `penalty_release_<missionId>`) — l'acheteur
 *      n'a jamais été débité (mission gelée DISPUTED_FRAUD), on ANNULE, on ne
 *      rembourse pas une capture inexistante (miroir de /admin/resolve-refund) ;
 *   4. $transaction : escrow HELD → CANCELLED (conditionnel, anti-TOCTOU) +
 *      outbox → SETTLED + `stripePaymentIntentId`.
 *
 * Idempotent par construction : l'idempotencyKey DÉTERMINISTE (dérivée de l'id
 * outbox immuable) rend `create`/`cancel` rejouables (même clé → même PI, aucun
 * double débit), le statut DB empêche la re-sélection. Un crash entre 2 et 4
 * laisse la ligne SUBMITTED : elle redevient éligible après STALE_SUBMITTED_MINUTES
 * et le rejeu est sans danger.
 *
 * Échec (carte refusée/fermée, off-session non abouti) : FAILED + backoff
 * exponentiel ; au M-ième échec → ABANDONED (terminal, hors scope worker) avec
 * UNE alerte critique PENALTY_DEBIT_ABANDONED (créance ouverte + hold acheteur
 * NON libéré — la libération est conditionnée au recouvrement). L'escrow acheteur
 * n'est JAMAIS touché tant que la ponction n'a pas réussi.
 */

/** Surface Stripe minimale — injectable (fake en test, vrai SDK en prod). */
export interface PenaltyDebitStripeClient {
  paymentIntents: {
    /** Débit off-session de la carte de garantie voyageur — recouvrement de la ponction 200%. */
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
    /**
     * Annule le hold HELD de l'acheteur (jamais capturé) — libération sur succès
     * de la ponction. OPTIONNELLE : présente sur le SDK réel, omise par les fakes
     * qui ne l'exercent pas. Signature 3-arg = SDK Stripe réel (clé en options).
     */
    cancel?(
      id: string,
      params: Record<string, never>,
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
}

export interface PenaltyWorkerDeps {
  prisma: PrismaClient
  stripe: PenaltyDebitStripeClient
  /**
   * M : seuil d'abandon. Au M-ième échec la ligne passe en ABANDONED (terminal —
   * hors scope worker ET requeue) avec UNE alerte critique PENALTY_DEBIT_ABANDONED,
   * émise à la transition uniquement.
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

interface ClaimedPenalty {
  id: string
  missionId: string
  amountCents: number
  attempts: number
  travelerPaymentMethodId: string | null
  travelerCustomerId: string | null
  escrowId: string | null
  buyerPaymentIntentId: string | null
  escrowStatus: EscrowStatus | null
}

/** Erreur structurelle : la carte de garantie du voyageur est absente (off-session impossible). */
class MissingPaymentMethodError extends Error {}
/** La charge off-session n'a pas abouti (`status !== 'succeeded'` sans throw). */
class PenaltyDebitNotSucceededError extends Error {}

/**
 * Réserve la prochaine ligne éligible. FOR UPDATE SKIP LOCKED : deux instances du
 * worker ne réservent pas la même ligne ; la transition SUBMITTED commit AVANT
 * tout appel Stripe. Backoff exponentiel des FAILED : éligible quand
 * updatedAt < now − 2^attempts minutes. Joint le voyageur (carte de garantie) et
 * l'escrow acheteur (hold à libérer) — figés post-arbitrage (mission gelée).
 */
async function claimNext(prisma: PrismaClient, maxAttempts: number): Promise<ClaimedPenalty | null> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PenaltyDebitOutbox"
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

    const claimed = await tx.penaltyDebitOutbox.update({
      where: { id: candidate.id },
      data: { status: TransferStatus.SUBMITTED },
      select: {
        id: true,
        missionId: true,
        amountCents: true,
        attempts: true,
        user: { select: { stripePaymentMethodId: true, stripeCustomerId: true } },
        mission: {
          select: {
            escrow: { select: { id: true, stripePaymentIntentId: true, status: true } },
          },
        },
      },
    })
    return {
      id: claimed.id,
      missionId: claimed.missionId,
      amountCents: claimed.amountCents,
      attempts: claimed.attempts,
      travelerPaymentMethodId: claimed.user.stripePaymentMethodId,
      travelerCustomerId: claimed.user.stripeCustomerId,
      escrowId: claimed.mission.escrow?.id ?? null,
      buyerPaymentIntentId: claimed.mission.escrow?.stripePaymentIntentId ?? null,
      escrowStatus: claimed.mission.escrow?.status ?? null,
    }
  })
}

/** Un passage du worker (un tick de cron). Relançable à volonté. */
export async function runPenaltyWorkerOnce(
  deps: PenaltyWorkerDeps,
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
      // (2) Charge off-session HORS transaction DB — l'idempotencyKey DÉTERMINISTE
      // (penalty_debit_<id>) garantit qu'un rejeu (retry, ligne SUBMITTED réclamée
      // après crash) ne crée pas un second débit : Stripe renvoie le PI existant.
      if (!claimed.travelerPaymentMethodId) {
        // Sprint 13 exige la carte au match/accept — absence = anomalie structurelle.
        throw new MissingPaymentMethodError('TRAVELER_PAYMENT_METHOD_MISSING')
      }
      const intent = await stripe.paymentIntents.create(
        {
          amount: claimed.amountCents,
          currency: 'eur',
          ...(claimed.travelerCustomerId ? { customer: claimed.travelerCustomerId } : {}),
          payment_method: claimed.travelerPaymentMethodId,
          confirm: true,
          off_session: true,
          metadata: { missionId: claimed.missionId, kind: 'fraud_penalty' },
        },
        { idempotencyKey: `penalty_debit_${claimed.id}` },
      )
      // off_session abouti = 'succeeded'. Tout autre statut (requires_action : 3DS
      // impossible hors session) est un échec → backoff (jamais un faux SETTLED).
      if (intent.status !== 'succeeded') {
        throw new PenaltyDebitNotSucceededError(`PENALTY_DEBIT_NOT_SUCCEEDED:${intent.status}`)
      }

      // (3) Libération du hold acheteur — HORS tx, sur succès UNIQUEMENT. Annulation
      // (jamais capturé) idempotente (clé penalty_release_<missionId>), conditionnée
      // à un escrow encore HELD lu au claim (mission DISPUTED_FRAUD gelée → pas de
      // course). Un escrow déjà non-HELD (rejeu après crash) saute proprement l'appel.
      if (
        claimed.escrowStatus === EscrowStatus.HELD &&
        claimed.buyerPaymentIntentId &&
        stripe.paymentIntents.cancel
      ) {
        await stripe.paymentIntents.cancel(
          claimed.buyerPaymentIntentId,
          {},
          { idempotencyKey: `penalty_release_${claimed.missionId}` },
        )
      }

      // (4) Effets DB atomiques : libération escrow (conditionnelle, anti-TOCTOU) +
      // outbox SETTLED. Aucun appel Stripe ici.
      await prisma.$transaction(async tx => {
        if (claimed.escrowId) {
          await tx.escrowTransaction.updateMany({
            where: { id: claimed.escrowId, status: EscrowStatus.HELD },
            data: { status: EscrowStatus.CANCELLED },
          })
        }
        await tx.penaltyDebitOutbox.update({
          where: { id: claimed.id },
          data: { status: TransferStatus.SETTLED, stripePaymentIntentId: intent.id },
        })
      })
      settled += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // M-ième échec → ABANDONED : terminal (carte fermée, créance irrécouvrable
      // automatiquement…). Sort du scope worker et du requeue.
      const isAbandon = claimed.attempts + 1 >= maxAttempts
      await prisma.penaltyDebitOutbox.update({
        where: { id: claimed.id },
        data: {
          status: isAbandon ? TransferStatus.ABANDONED : TransferStatus.FAILED,
          lastError: message,
          attempts: { increment: 1 }, // backoff : ré-éligible après 2^attempts minutes
        },
      })
      if (isAbandon) {
        abandoned += 1
        // Alerte critique UNE SEULE FOIS — à la transition. Le hold acheteur n'a PAS
        // été libéré (libération conditionnée au recouvrement) : double action humaine.
        safeEmit(deps.onAlert, {
          code: 'PENALTY_DEBIT_ABANDONED',
          message: `Ponction de pénalité abandonnée après ${claimed.attempts + 1} tentatives — recouvrement humain requis (carte voyageur non débitée, hold acheteur toujours en place)`,
          details: {
            outboxId: claimed.id,
            missionId: claimed.missionId,
            amountCents: claimed.amountCents,
            lastError: message,
          },
        })
      } else {
        failed += 1
      }
      log.error({ outboxId: claimed.id, err: message }, 'penalty outbox: ponction échouée')
    }
  }

  return { settled, failed, abandoned }
}

/**
 * Boucle cron explicite (~1 min) — pas un timer caché : c'est LE mécanisme
 * documenté d'exécution des ponctions de pénalité (miroir de transfer-worker).
 */
export function startPenaltyWorkerLoop(
  deps: PenaltyWorkerDeps,
  intervalMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => {
    void runPenaltyWorkerOnce(deps).catch(err =>
      (deps.log ?? console).error({ err }, 'penalty worker tick failed'),
    )
  }, intervalMs)
}
