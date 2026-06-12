import { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db'
import { findMissionForParticipant } from './mission-access'

/**
 * API missions — création & consultation. AUCUNE interaction Stripe ici :
 * la mission naît en CREATED (non financée). Le financement T0 (EscrowTransaction
 * + PaymentIntent) est la brique 2b.
 *
 * Toutes les routes sont protégées (JWT) et autorisées PAR RESSOURCE
 * (cf. mission-access.ts) — jamais par un rôle de compte.
 */

interface CreateMissionBody {
  targetProduct: string
  budgetCents: number
  commissionCents: number
  destination: string
  expiresAt: string
}

// budgetCents > 0, commissionCents ≥ 0 ; tous deux FIGÉS à la création
// (rules.md #4 : aucune route ne les modifie). expiresAt : format vérifié en
// applicatif (l'ajv de Fastify 4 n'embarque pas le format date-time).
const createMissionBodySchema = {
  type: 'object',
  required: ['targetProduct', 'budgetCents', 'commissionCents', 'destination', 'expiresAt'],
  additionalProperties: false,
  properties: {
    targetProduct: { type: 'string', minLength: 1, maxLength: 500 },
    budgetCents: { type: 'integer', minimum: 1 },
    commissionCents: { type: 'integer', minimum: 0 },
    destination: { type: 'string', minLength: 1, maxLength: 200 },
    expiresAt: { type: 'string', minLength: 1 },
  },
} as const

const missionIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const

const missionRoute: FastifyPluginAsync = async app => {
  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'INVALID_INPUT' })
    req.log.error({ err }, 'mission route error')
    return reply.code(500).send({ error: 'INTERNAL_ERROR' })
  })

  // Auth en onRequest (AVANT la validation) : un non-authentifié reçoit 401,
  // jamais un 400 qui révélerait les règles de validation sans jeton.
  app.addHook('onRequest', app.authenticate)

  // POST /api/missions — l'utilisateur courant devient l'acheteur.
  app.post('/', { schema: { body: createMissionBodySchema } }, async (req, reply) => {
    const body = req.body as CreateMissionBody
    const expiresAtMs = Date.parse(body.expiresAt)
    if (Number.isNaN(expiresAtMs)) {
      return reply.code(400).send({ error: 'INVALID_INPUT' })
    }
    if (expiresAtMs <= Date.now()) {
      return reply.code(400).send({ error: 'EXPIRES_AT_IN_PAST' })
    }
    const mission = await prisma.mission.create({
      data: {
        buyerId: req.user.sub,
        targetProduct: body.targetProduct,
        budgetCents: body.budgetCents,
        commissionCents: body.commissionCents,
        destination: body.destination,
        expiresAt: new Date(expiresAtMs),
        // status : défaut CREATED. travelerId : null (assignation = matchmaking, plus tard).
      },
    })
    return reply.code(201).send(mission)
  })

  // GET /api/missions — mes missions (acheteur ET voyageur), jamais celles des autres.
  app.get('/', async (req, reply) => {
    const userId = req.user.sub
    const missions = await prisma.mission.findMany({
      where: { OR: [{ buyerId: userId }, { travelerId: userId }] },
      orderBy: { createdAt: 'desc' },
    })
    return reply.code(200).send(missions)
  })

  // GET /api/missions/:id — visible par l'acheteur OU le voyageur assigné ;
  // tiers → 404 (ne révèle pas l'existence).
  app.get('/:id', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const access = await findMissionForParticipant(prisma, id, req.user.sub)
    if (!access) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
    return reply.code(200).send(access.mission)
  })
}

export default missionRoute
