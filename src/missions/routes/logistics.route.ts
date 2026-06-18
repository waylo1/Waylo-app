import { FastifyPluginAsync } from 'fastify'
import { missionIdParamsSchema, MissionRouteOptions } from '../mission-common'

export const logisticsRoutes: FastifyPluginAsync<MissionRouteOptions> = async app => {
  // POST /api/missions/:id/receive — placeholder
  app.post('/:id/receive', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/customs-receipt — placeholder
  app.post('/:id/customs-receipt', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/customs-approve — placeholder
  app.post('/:id/customs-approve', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/customs-reject — placeholder
  app.post('/:id/customs-reject', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/dropoff-receipt — placeholder
  app.post('/:id/dropoff-receipt', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/confirm-collection — placeholder
  app.post('/:id/confirm-collection', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/ship — placeholder
  app.post('/:id/ship', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })

  // POST /api/missions/:id/submit-receipt — placeholder
  app.post('/:id/submit-receipt', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })
}
