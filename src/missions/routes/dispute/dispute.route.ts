import { FastifyPluginAsync, FastifyReply } from 'fastify'
import { missionIdParamsSchema, MissionRouteOptions } from '../../mission-common'
import {
  createDispute,
  openDispute,
  escalateDispute,
  resolveDispute,
  closeDispute,
  getDispute,
  DisputeError,
} from '../../../services/dispute.service'

/**
 * Domaine DISPUTE — cycle de vie structuré (DisputeService). Authentification JWT
 * héritée du parent ; autorisation par ressource déléguée au service (404 masquant
 * pour un tiers, 403 pour les actions admin). Erreurs typées → { error: SNAKE_CASE }.
 */

const HTTP_BY_CODE: Record<string, number> = {
  MISSION_NOT_FOUND: 404,
  DISPUTE_NOT_FOUND: 404,
  FORBIDDEN: 403,
  DISPUTE_INVALID_STATE: 409,
}

function fail(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DisputeError) {
    return reply.code(HTTP_BY_CODE[err.code] ?? 400).send({ error: err.code })
  }
  throw err
}

const reasonBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { reason: { type: 'string', maxLength: 2000 } },
} as const

const resolutionBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { resolution: { type: 'string', maxLength: 2000 } },
} as const

export const disputeRoutes: FastifyPluginAsync<MissionRouteOptions> = async app => {
  // POST /:id/dispute/draft — l'acheteur initie un litige (DRAFT, idempotent).
  app.post(
    '/:id/dispute/draft',
    { schema: { params: missionIdParamsSchema, body: reasonBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { reason } = (req.body ?? {}) as { reason?: string }
      try {
        const dispute = await createDispute({ missionId: id, actorId: req.user.sub, reason })
        return reply.code(201).send(dispute)
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  // POST /:id/dispute/open — DRAFT → OPEN (acheteur).
  app.post('/:id/dispute/open', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      return reply.code(200).send(await openDispute({ missionId: id, actorId: req.user.sub }))
    } catch (err) {
      return fail(reply, err)
    }
  })

  // POST /:id/dispute/escalate — OPEN → ESCALATED (participant).
  app.post('/:id/dispute/escalate', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      return reply.code(200).send(await escalateDispute({ missionId: id, actorId: req.user.sub }))
    } catch (err) {
      return fail(reply, err)
    }
  })

  // POST /:id/dispute/resolve — OPEN | ESCALATED → RESOLVED (admin).
  app.post(
    '/:id/dispute/resolve',
    { schema: { params: missionIdParamsSchema, body: resolutionBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const { resolution } = (req.body ?? {}) as { resolution?: string }
      try {
        return reply
          .code(200)
          .send(await resolveDispute({ missionId: id, actorId: req.user.sub, resolution }))
      } catch (err) {
        return fail(reply, err)
      }
    },
  )

  // POST /:id/dispute/close — RESOLVED → CLOSED (admin, terminal).
  app.post('/:id/dispute/close', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      return reply.code(200).send(await closeDispute({ missionId: id, actorId: req.user.sub }))
    } catch (err) {
      return fail(reply, err)
    }
  })

  // GET /:id/dispute/details — lecture (participant).
  app.get('/:id/dispute/details', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      return reply.code(200).send(await getDispute({ missionId: id, actorId: req.user.sub }))
    } catch (err) {
      return fail(reply, err)
    }
  })
}
