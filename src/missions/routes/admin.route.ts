import { FastifyPluginAsync } from 'fastify'
import { missionIdParamsSchema, MissionRouteOptions } from '../mission-common'

export const adminRoutes: FastifyPluginAsync<MissionRouteOptions> = async app => {
  // POST /api/missions/:id/dispute — placeholder
  app.post('/:id/dispute', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/admin/resolve-refund — placeholder
  app.post('/:id/admin/resolve-refund', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/admin/resolve-payout — placeholder
  app.post('/:id/admin/resolve-payout', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/match — placeholder
  app.post('/:id/match', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/accept — placeholder
  app.post('/:id/accept', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/start-travel — placeholder
  app.post('/:id/start-travel', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/review — placeholder
  app.post('/:id/review', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })
}
