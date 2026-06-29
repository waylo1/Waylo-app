import { FastifyPluginAsync } from 'fastify'
import { findMissionsForTraveler } from '../mission.service'

export const listRoutes: FastifyPluginAsync = async app => {
  // GET /api/missions/my-missions — voyageur consulte ses missions (statuts en cours MATCHED→VALIDATED + RELEASED)
  app.get('/my-missions', async (req, reply) => {
    const travelerId = req.user.sub
    const missions = await findMissionsForTraveler(travelerId)
    return reply.code(200).send(missions)
  })
}
