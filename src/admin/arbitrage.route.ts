import { FastifyError, FastifyPluginAsync } from 'fastify'
import { prisma } from '../db'
import { DeliveryProofStatus, LedgerType, MissionStatus } from '../generated/prisma'
import { isRequestAdmin } from '../missions/mission-common'
import { ArbitrageError, updateDeliveryProof } from '../services/arbitrage.service'

/**
 * API admin — arbitrage de FRAUDE / VOL voyageur (Sprint 14).
 *
 * POST /api/admin/missions/:id/arbitrate-fraud : un admin (`isRequestAdmin`, lookup
 * DB frais — JWT inchangé, identité seule) tranche qu'un litige (`DISPUTED`) relève
 * d'une fraude/vol avéré du voyageur. Effet, dans UNE seule `$transaction` (AUCUN
 * appel Stripe — règle d'or trivialement respectée) :
 *   1. transition conditionnelle anti-TOCTOU `DISPUTED → DISPUTED_FRAUD` (gelé terminal) ;
 *   2. `PenaltyDebitOutbox` PENDING pour le voyageur : ponction 200% de (Objet + Frais) ;
 *   3. `BuyerCompensationOutbox` PENDING pour l'acheteur : compensation 120% (exécution différée) ;
 *   4. `LedgerEntry` `FRAUD_PENALTY_COLLECTED` (200%) + `BUYER_REFUND_COMPENSATION` (120%) ;
 *   5. `AdminAuditLog` (invariant D-c : toute décision admin tracée atomiquement).
 *
 * Base de calcul : (`budgetCents` [Valeur Objet] + `commissionCents` [Frais Service]) ;
 * ponction = base × 2 (200%), compensation acheteur = base × 1,2 (120%). La marge
 * plateforme (80%) est implicite (ponction − compensation) — aucun 3e type demandé.
 *
 * SÉPARATION ESCROW : les deux nouveaux types de ledger sont EXCLUS des invariants
 * A/B/C — la réconciliation ne somme que CAPTURE/PAYOUT/COMMISSION/REFUND. Ils sont
 * ancrés à l'escrow de la mission UNIQUEMENT pour la FK ; ils ne représentent PAS un
 * mouvement du séquestre acheteur. L'EXÉCUTION monétaire (débit de la carte de
 * garantie du voyageur, sortie du hold acheteur, versement de la compensation 120%)
 * relève d'un worker dédié — hors scope de ce sprint (intention enregistrée, exécution
 * différée : pattern outbox, comme TransferOutbox).
 *
 * Erreurs : non-admin → 403 `FORBIDDEN` ; mission absente ou non-`DISPUTED` → 400
 * `MISSION_NOT_DISPUTED` ; escrow absent → 400 `ESCROW_NOT_FOUND`.
 */

const missionIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const

// Validation stricte : seules les ISSUES d'arbitrage (VALIDATED | REJECTED) sont
// acceptées — PENDING est le défaut initial, jamais une décision. enum dérivé des
// valeurs Prisma DeliveryProofStatus (source unique). additionalProperties:false :
// tout champ inattendu → 400 INVALID_INPUT (fail-closed).
const deliveryProofBodySchema = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: [DeliveryProofStatus.VALIDATED, DeliveryProofStatus.REJECTED],
    },
  },
} as const

/** Transition DISPUTED → DISPUTED_FRAUD perdue (course / mission déjà arbitrée). */
class ArbitrateFraudConflictError extends Error {}

const arbitrageRoute: FastifyPluginAsync = async app => {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'INVALID_INPUT' })
    req.log.error({ err }, 'admin arbitrage route error')
    return reply.code(500).send({ error: 'INTERNAL_ERROR' })
  })

  // Auth en onRequest (AVANT la validation) : un non-authentifié reçoit 401.
  app.addHook('onRequest', app.authenticate)

  app.post(
    '/missions/:id/arbitrate-fraud',
    { schema: { params: missionIdParamsSchema } },
    async (req, reply) => {
      if (!(await isRequestAdmin(req.user.sub))) {
        return reply.code(403).send({ error: 'FORBIDDEN' })
      }
      const { id } = req.params as { id: string }

      // Lecture hors tx : montants figés (budget/commission gelés post-MATCHED),
      // escrow.id et travelerId immuables. La garde d'état AUTORITAIRE reste le
      // updateMany conditionnel dans la $transaction (anti-TOCTOU).
      const mission = await prisma.mission.findUnique({
        where: { id },
        select: {
          status: true,
          buyerId: true,
          travelerId: true,
          budgetCents: true,
          commissionCents: true,
          escrow: { select: { id: true } },
        },
      })
      // Route admin de confiance : mission absente ⇒ même 400 (pas de masquage IDOR).
      if (!mission || mission.status !== MissionStatus.DISPUTED) {
        return reply.code(400).send({ error: 'MISSION_NOT_DISPUTED' })
      }
      if (!mission.escrow) {
        return reply.code(400).send({ error: 'ESCROW_NOT_FOUND' })
      }
      if (!mission.travelerId) {
        // Impossible pour une mission DISPUTED (passée par MATCHED) — garde défensive.
        return reply.code(400).send({ error: 'TRAVELER_NOT_ASSIGNED' })
      }

      const escrowId = mission.escrow.id
      const travelerId = mission.travelerId
      const buyerId = mission.buyerId // bénéficiaire de la compensation 120% (non-null en DB)
      // Base = Valeur Objet (budget) + Frais Service Plateforme (commission).
      const baseCents = mission.budgetCents + mission.commissionCents
      const penaltyCents = baseCents * 2 // 200% — ponction voyageur
      const compensationCents = Math.round((baseCents * 12) / 10) // 120% — compensation acheteur

      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id, status: MissionStatus.DISPUTED },
            data: { status: MissionStatus.DISPUTED_FRAUD },
          })
          if (updated.count !== 1) throw new ArbitrateFraudConflictError()

          // Intention de ponction (exécution Stripe différée au worker dédié).
          await tx.penaltyDebitOutbox.create({
            data: { missionId: id, userId: travelerId, amountCents: penaltyCents },
          })

          // Intention de compensation acheteur 120% (exécution Wallet/payout différée au
          // worker dédié). idempotencyKey @unique = une seule restitution par mission.
          await tx.buyerCompensationOutbox.create({
            data: {
              missionId: id,
              buyerId,
              amountCents: compensationCents,
              idempotencyKey: `buyer_compensation_${id}`,
            },
          })

          // Journal comptable du flux pénalité — hors invariant escrow (cf. en-tête).
          await tx.ledgerEntry.createMany({
            data: [
              { escrowId, type: LedgerType.FRAUD_PENALTY_COLLECTED, amountCents: penaltyCents },
              {
                escrowId,
                type: LedgerType.BUYER_REFUND_COMPENSATION,
                amountCents: compensationCents,
              },
            ],
          })

          await tx.adminAuditLog.create({
            data: { adminId: req.user.sub, action: 'ADMIN_ARBITRATE_FRAUD', missionId: id },
          })
        })
      } catch (err) {
        if (err instanceof ArbitrateFraudConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_DISPUTED' })
        }
        throw err
      }

      const arbitrated = await prisma.mission.findUniqueOrThrow({ where: { id } })
      return reply.code(200).send(arbitrated)
    },
  )

  /**
   * PATCH /api/admin/missions/:id/delivery-proof — arbitrage HUMAIN de la preuve de
   * livraison. Un admin (`isRequestAdmin`) pose `deliveryProofStatus` (VALIDATED |
   * REJECTED). VALIDATED = preuve acceptée → contestation facturable (lu par
   * disputeResolutionWorker). Effet ATOMIQUE (service) : update + AdminAuditLog
   * (actor=ADMIN, adminId=acteur). Mission absente → 404 ; status invalide → 400.
   */
  app.patch(
    '/missions/:id/delivery-proof',
    { schema: { params: missionIdParamsSchema, body: deliveryProofBodySchema } },
    async (req, reply) => {
      if (!(await isRequestAdmin(req.user.sub))) {
        return reply.code(403).send({ error: 'FORBIDDEN' })
      }
      const { id } = req.params as { id: string }
      const { status } = req.body as { status: DeliveryProofStatus }

      try {
        const mission = await updateDeliveryProof(id, req.user.sub, status)
        return reply.code(200).send(mission)
      } catch (err) {
        if (err instanceof ArbitrageError) {
          return reply.code(404).send({ error: err.code })
        }
        throw err
      }
    },
  )
}

export default arbitrageRoute
