import { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db'
import { isRequestAdmin } from '../missions/mission-common'
import { AppError } from '../errors/app.error'
import { getWorkerTimings } from '../monitoring/workerTiming'
import { readPrismaPoolStats } from '../monitoring/prismaPool'

/**
 * GET /debug/performance — endpoint de DIAGNOSTIC, réservé aux admins.
 *
 * Auth identique aux routes /api/admin/* : preHandler JWT (`authenticate`, en
 * onRequest → 401 si non authentifié) PUIS `isRequestAdmin` (lookup DB frais →
 * 403 `FORBIDDEN` pour un non-admin). Pas de token statique : on réutilise le
 * guard JWT+isAdmin du reste de l'app (CLAUDE.md « routes protégées JWT »).
 *
 * Lecture seule, aucun effet de bord :
 *   - prismaPool : jauges du pool de connexions Prisma ($metrics) — null si indispo ;
 *   - workers : temps moyen des 10 dernières boucles par worker (registre mémoire) ;
 *   - memory : process.memoryUsage() (rss, heap, external…).
 */
export const debugRoutes: FastifyPluginAsync = async app => {
  // Auth en onRequest (AVANT le handler) : un non-authentifié reçoit 401.
  app.addHook('onRequest', app.authenticate)

  app.get('/performance', async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      throw new AppError('FORBIDDEN', 403)
    }

    const pool = await readPrismaPoolStats(prisma)
    const mem = process.memoryUsage()

    return reply.code(200).send({
      collectedAt: new Date().toISOString(),
      // null = preview feature `metrics` indisponible ou collecte en échec.
      prismaPool: pool,
      workers: getWorkerTimings(),
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
    })
  })
}

export default debugRoutes
