import { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db'
import { MissionStatus } from '../generated/prisma'
import { findMissionForBuyer } from '../missions/mission-access'
import type { PaymentIntentClient } from '../missions/mission-common'
import { captureEscrowFunds, EscrowCaptureError } from '../services/escrow.service'
import { AppError } from '../errors/app.error'

/**
 * API escrow — capture du séquestre (T1) exposée hors tunnel mission.
 *
 * SEUL effet de la route : déléguer à `captureEscrowFunds`, qui ne fait QUE
 * l'appel Stripe `paymentIntents.capture` (aucune écriture DB). La source de
 * vérité (escrow → RELEASED, ledger, mission → RELEASED) reste portée par le
 * webhook payment_intent.succeeded — jamais dupliquée ici.
 *
 * Gardes AVANT toute capture (D-a) — ce chemin hors tunnel partage la même
 * exigence de sécurité que POST /api/missions/:id/validate :
 *   1. Autorisation PAR RESSOURCE : seul l'ACHETEUR de la mission peut capturer.
 *      Sans elle, tout utilisateur authentifié pouvait déclencher la capture du
 *      séquestre de n'importe quelle mission (IDOR).
 *   2. Garde douane : refus si la mission est sous verrou douanier — sinon la
 *      capture contourne la garde de /validate et le webhook tape son backstop
 *      CUSTOMS_LOCK_CAPTURED (fonds pris côté Stripe sans libération possible).
 *
 * Mapping des erreurs :
 *   MISSION_NOT_FOUND   → 404 (mission inexistante OU appelant non-acheteur, indistinguables)
 *   CUSTOMS_LOCK_ACTIVE → 409 (verrou douanier actif : ESCROW_LOCKED_CUSTOMS | PENDING_CUSTOMS_REVIEW)
 *   ESCROW_NOT_FOUND    → 404 (l'escrow n'existe pas)
 *   ESCROW_NOT_HELD     → 400 (statut non capturable)
 */
export interface EscrowRouteOptions {
  stripe: PaymentIntentClient
}

const missionIdParamsSchema = {
  type: 'object',
  required: ['missionId'],
  properties: { missionId: { type: 'string', minLength: 1 } },
} as const

const escrowRoute: FastifyPluginAsync<EscrowRouteOptions> = async (app, opts) => {
  // Auth en onRequest (AVANT la validation) : un non-authentifié reçoit 401.
  app.addHook('onRequest', app.authenticate)

  // POST /api/escrow/:missionId/capture — déclenche la capture Stripe du séquestre.
  app.post(
    '/:missionId/capture',
    { schema: { params: missionIdParamsSchema } },
    async (req, reply) => {
      const { missionId } = req.params as { missionId: string }

      // Garde 1 — autorisation PAR RESSOURCE (D-a) : 404 si la mission n'existe
      // pas OU si l'appelant n'en est pas l'acheteur (voyageur/tiers) — les deux
      // cas indistinguables, l'existence n'est jamais révélée à un tiers.
      const mission = await findMissionForBuyer(prisma, missionId, req.user.sub)
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

      // Garde 2 — verrou douanier (D-a) : une mission en revue douanière ne peut
      // JAMAIS être capturée par ce chemin (cf. la même garde dans /validate).
      if (
        mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
        mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
      ) {
        throw new AppError('CUSTOMS_LOCK_ACTIVE', 409)
      }

      // Garde 3 — CAS atomique : AWAITING_VALIDATION → VALIDATED.
      // updateMany WHERE status=AWAITING_VALIDATION est le seul point d'exclusion mutuelle.
      // PostgreSQL garantit count=1 pour un seul gagnant ; les 49 autres voient count=0 → 409.
      // L'appel Stripe (hors $transaction) ne suit que si count=1.
      const cas = await prisma.mission.updateMany({
        where: { id: missionId, status: MissionStatus.AWAITING_VALIDATION },
        data: { status: MissionStatus.VALIDATED },
      })
      if (cas.count === 0) throw new AppError('MISSION_ALREADY_CAPTURED', 409)

      try {
        const result = await captureEscrowFunds(missionId, opts.stripe)
        return reply.code(200).send(result)
      } catch (err) {
        // Rollback CAS si Stripe échoue — mission revient capturable.
        await prisma.mission.update({
          where: { id: missionId },
          data: { status: MissionStatus.AWAITING_VALIDATION },
        })
        if (err instanceof EscrowCaptureError) {
          if (err.code === 'ESCROW_NOT_FOUND') throw new AppError(err.code, 404)
          if (err.code === 'ESCROW_NOT_HELD') throw new AppError(err.code, 400)
        }
        throw err
      }
    },
  )
}

export default escrowRoute
