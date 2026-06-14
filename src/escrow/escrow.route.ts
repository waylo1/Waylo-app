import { FastifyPluginAsync } from 'fastify'
import type { PaymentIntentClient } from '../missions/mission.route'
import { captureEscrowFunds, EscrowCaptureError } from '../services/escrow.service'

/**
 * API escrow — capture du séquestre (T1) exposée hors tunnel mission.
 *
 * SEUL effet de la route : déléguer à `captureEscrowFunds`, qui ne fait QUE
 * l'appel Stripe `paymentIntents.capture` (aucune écriture DB). La source de
 * vérité (escrow → RELEASED, ledger, mission → RELEASED) reste portée par le
 * webhook payment_intent.succeeded — jamais dupliquée ici.
 *
 * Mapping des erreurs typées du service :
 *   ESCROW_NOT_FOUND → 404 (l'escrow n'existe pas)
 *   ESCROW_NOT_HELD  → 400 (statut non capturable)
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
  app.setErrorHandler((err, req, reply) => {
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
