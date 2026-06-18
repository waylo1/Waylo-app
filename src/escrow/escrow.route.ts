import { FastifyError, FastifyPluginAsync } from 'fastify'
import { prisma } from '../db'
import { MissionStatus } from '../generated/prisma'
import { findMissionForBuyer } from '../missions/mission-access'
import type { PaymentIntentClient } from '../missions/mission-common'
import { captureEscrowFunds, EscrowCaptureError } from '../services/escrow.service'

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
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'INVALID_INPUT' })
    req.log.error({ err }, 'escrow route error')
    return reply.code(500).send({ error: 'INTERNAL_ERROR' })
  })

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
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

      // Garde 2 — verrou douanier (D-a) : une mission en revue douanière ne peut
      // JAMAIS être capturée par ce chemin (cf. la même garde dans /validate).
      if (
        mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
        mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
      ) {
        return reply.code(409).send({ error: 'CUSTOMS_LOCK_ACTIVE' })
      }

      try {
        const result = await captureEscrowFunds(missionId, opts.stripe)
        return reply.code(200).send(result)
      } catch (err) {
        if (err instanceof EscrowCaptureError) {
          if (err.code === 'ESCROW_NOT_FOUND') return reply.code(404).send({ error: err.code })
          if (err.code === 'ESCROW_NOT_HELD') return reply.code(400).send({ error: err.code })
        }
        throw err
      }
    },
  )
}

export default escrowRoute
