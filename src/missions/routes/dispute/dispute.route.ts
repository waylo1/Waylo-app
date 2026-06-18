import { FastifyPluginAsync } from 'fastify'
import { missionIdParamsSchema, MissionRouteOptions } from '../../mission-common'

/**
 * Domaine DISPUTE (extensions) — scaffolding (Sprint à venir).
 *
 * NB : l'ouverture de litige acheteur (`POST /:id/dispute`) et l'arbitrage admin
 * (`/:id/admin/resolve-refund` · `/:id/admin/resolve-payout`) vivent déjà dans
 * `admin.route.ts` et sont fonctionnels. Ce domaine accueillera les EXTENSIONS
 * (pièces jointes au litige, historique de décision, escalade) — stubs 501 pour
 * figer les chemins sans dupliquer l'existant.
 */
export const disputeRoutes: FastifyPluginAsync<MissionRouteOptions> = async app => {
  // GET /api/missions/:id/dispute/details — détail/historique du litige (stub).
  app.get('/:id/dispute/details', { schema: { params: missionIdParamsSchema } }, async (_req, reply) => {
    return reply.code(501).send({ error: 'NOT_IMPLEMENTED' })
  })
}
