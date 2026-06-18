import { FastifyPluginAsync } from 'fastify'
import { missionIdParamsSchema, MissionRouteOptions } from '../../mission-common'

/**
 * Domaine WALLET — scaffolding (Sprint à venir).
 *
 * Surface prévue : consultation du solde Wallet interne, historique des
 * mouvements (compensation fraude, top-up, delta substitution). Stubs 501
 * pour figer les chemins ; aucune écriture financière tant que la logique
 * réelle (prisma.$transaction + transition atomique) n'est pas portée.
 */
export const walletRoutes: FastifyPluginAsync<MissionRouteOptions> = async app => {
  // GET /api/missions/:id/wallet — solde + mouvements liés à la mission (stub).
  app.get('/:id/wallet', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })
}
