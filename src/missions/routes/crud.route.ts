import { FastifyPluginAsync } from 'fastify'
import { Prisma, MissionStatus } from '../../generated/prisma'
import { prisma } from '../../db'
import { findMissionForParticipant } from '../mission-access'
import { missionIdParamsSchema, availableQuerySchema } from '../mission-common'
import { AppError } from '../../errors/app.error'

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
    return reply.code(201).send(mission)
  })

  // GET /api/missions — mes missions
  app.get('/', async (req, reply) => {
    const userId = req.user.sub
    const missions = await prisma.mission.findMany({
      where: { OR: [{ buyerId: userId }, { travelerId: userId }] },
      orderBy: { createdAt: 'desc' },
    })
    return reply.code(200).send(missions)
  })

  // GET /api/missions/available — vitrine pour voyageur
  app.get('/available', { schema: { querystring: availableQuerySchema } }, async (req, reply) => {
    const { origin, destination } = req.query as { origin?: string; destination?: string }
    const where: Prisma.MissionWhereInput = {
      status: MissionStatus.FUNDED,
      buyerId: { not: req.user.sub },
    }
    if (origin) where.origin = { contains: origin, mode: 'insensitive' }
    if (destination) where.destination = { contains: destination, mode: 'insensitive' }
    const missions = await prisma.mission.findMany({ where, orderBy: { createdAt: 'desc' } })
    return reply.code(200).send(missions)
  })

  // GET /api/missions/:id
  app.get('/:id', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const access = await findMissionForParticipant(prisma, id, req.user.sub)
    if (!access) throw new AppError('MISSION_NOT_FOUND', 404)
    const mission = await prisma.mission.findUniqueOrThrow({
      where: { id },
      include: { receipt: { select: { totalTtcCents: true, receiptUrl: true, sealedAt: true } } },
    })
    return reply.code(200).send(mission)
  })
}
