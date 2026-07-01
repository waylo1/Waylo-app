import { FastifyPluginAsync } from 'fastify'
import { Prisma, MissionStatus } from '../../generated/prisma'
import { prisma } from '../../db'
import { findMissionForParticipant } from '../mission-access'
import { missionIdParamsSchema, availableQuerySchema } from '../mission-common'
import { AppError } from '../../errors/app.error'
import { triggerMissionCreatedNotification } from '../mission.service'
import { mapToPublicMissionDTO, PublicMissionDTO } from './mission.dto'
import { withRlsContext } from '../../lib/rls-context'

export const crudRoutes: FastifyPluginAsync = async app => {
  // POST /api/missions — l'utilisateur courant devient l'acheteur.
  app.post('/', { schema: { body: { type: 'object', required: ['targetProduct', 'budgetCents', 'commissionCents', 'origin', 'destination', 'destinationCountry', 'expiresAt'], additionalProperties: false, properties: { targetProduct: { type: 'string', minLength: 1, maxLength: 500 }, budgetCents: { type: 'integer', minimum: 1 }, commissionCents: { type: 'integer', minimum: 0 }, origin: { type: 'string', minLength: 1, maxLength: 200 }, destination: { type: 'string', minLength: 1, maxLength: 200 }, destinationCountry: { type: 'string', pattern: '^[A-Za-z]{2}$' }, expiresAt: { type: 'string', minLength: 1 }, substitutionAuthorized: { type: 'boolean' } } } } }, async (req, reply) => {
    const body = req.body as any
    const expiresAtMs = Date.parse(body.expiresAt)
    if (Number.isNaN(expiresAtMs)) throw new AppError('INVALID_INPUT', 400)
    if (expiresAtMs <= Date.now()) throw new AppError('EXPIRES_AT_IN_PAST', 400)
    const mission = await prisma.mission.create({
      data: {
        buyerId: req.user.sub,
        targetProduct: body.targetProduct,
        budgetCents: body.budgetCents,
        commissionCents: body.commissionCents,
        origin: body.origin,
        destination: body.destination,
        destinationCountry: body.destinationCountry.toUpperCase(),
        expiresAt: new Date(expiresAtMs),
        substitutionAuthorized: body.substitutionAuthorized ?? false,
      },
    })
    // Fire-and-forget APRÈS commit DB — un échec de notification ne rollback JAMAIS la mission.
    triggerMissionCreatedNotification(mission.id).catch(err =>
      req.log.error({ err }, '[mission-created] unexpected error in notification'),
    )
    return reply.code(201).send(mission)
  })

  // GET /api/missions — mes missions (sérialisation via whitelist DTO, privacy-first)
  // RLS enforce : identité seule suffit (pas de gate KYC sur la lecture Mission).
  app.get('/', async (req, reply) => {
    const userId = req.user.sub
    const missions = await withRlsContext({ userId, readOnly: true }, tx =>
      tx.mission.findMany({
        where: { OR: [{ buyerId: userId }, { travelerId: userId }] },
        orderBy: { createdAt: 'desc' },
      }),
    )
    const body: PublicMissionDTO[] = missions.map(mapToPublicMissionDTO)
    return reply.code(200).send(body)
  })

  // GET /api/missions/available — vitrine pour voyageur
  // RLS enforce, CONTEXTE SERVICE : la policy mission_select n'a pas de carve-out
  // public pour FUNDED — le catalogue est servi via `isService`, le filtrage
  // (FUNDED, sans voyageur, hors mes missions) reste porté par le `where` Prisma.
  app.get('/available', { schema: { querystring: availableQuerySchema } }, async (req, reply) => {
    const { origin, destination } = req.query as { origin?: string; destination?: string }
    const where: Prisma.MissionWhereInput = {
      status: MissionStatus.FUNDED,
      buyerId: { not: req.user.sub },
    }
    if (origin) where.origin = { contains: origin, mode: 'insensitive' }
    if (destination) where.destination = { contains: destination, mode: 'insensitive' }
    const missions = await withRlsContext({ isService: true, readOnly: true }, tx =>
      tx.mission.findMany({ where, orderBy: { createdAt: 'desc' } }),
    )
    return reply.code(200).send(missions)
  })

  // GET /api/missions/:id
  // RLS enforce : garde applicative (findMissionForParticipant) ET garde RLS
  // s'exécutent dans LA MÊME transaction/rôle waylo_app — défense en profondeur réelle.
  app.get('/:id', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await withRlsContext({ userId: req.user.sub, readOnly: true }, async tx => {
      const access = await findMissionForParticipant(tx, id, req.user.sub)
      if (!access) throw new AppError('MISSION_NOT_FOUND', 404)
      return tx.mission.findUniqueOrThrow({
        where: { id },
        include: { receipt: { select: { totalTtcCents: true, receiptUrl: true, sealedAt: true } } },
      })
    })
    return reply.code(200).send(mission)
  })
}
