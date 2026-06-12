import { createHash } from 'node:crypto'
import { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db'
import { EscrowStatus, MissionStatus, Prisma } from '../generated/prisma'
import {
  findMissionForBuyer,
  findMissionForParticipant,
  findMissionForTraveler,
} from './mission-access'

/**
 * API missions — création, consultation, financement T0.
 *
 * Toutes les routes sont protégées (JWT) et autorisées PAR RESSOURCE
 * (cf. mission-access.ts) — jamais par un rôle de compte.
 *
 * Financement T0 (POST /:id/intent) : PaymentIntent à capture différée
 * (séquestre) + EscrowTransaction HELD + mission FUNDED. Règle d'or respectée :
 * AUCUN appel Stripe dans une transaction DB — le PI est créé AVANT, avec une
 * idempotencyKey déterministe par mission (un retry après crash récupère le
 * MÊME PaymentIntent, jamais un doublon).
 */

/** Surface Stripe minimale — injectable (fake en test, SDK réel en prod). */
export interface PaymentIntentClient {
  paymentIntents: {
    create(
      params: {
        amount: number
        currency: string
        capture_method: 'manual'
        metadata: Record<string, string>
      },
      options: { idempotencyKey: string },
    ): Promise<{ id: string; client_secret: string | null }>
    /** Capture (T1) du séquestre — montant total autorisé. idempotencyKey déterministe par mission. */
    capture(
      id: string,
      params: Record<string, never>,
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
}

export interface MissionRouteOptions {
  stripe: PaymentIntentClient
}

/** Transition CREATED → FUNDED perdue (course) : la mission vient d'être financée ailleurs. */
class FundingConflictError extends Error {}

/** Transition AWAITING_VALIDATION → VALIDATED perdue (course / double validation). */
class ValidationConflictError extends Error {}

/** Transition FUNDED → MATCHED perdue (course : un autre voyageur a pris la mission). */
class MatchConflictError extends Error {}

/** Transition MATCHED → IN_PROGRESS perdue (course / double départ). */
class StartTravelConflictError extends Error {}

/** Transition IN_PROGRESS → AWAITING_VALIDATION perdue (course / double dépôt de reçu). */
class ReceiptConflictError extends Error {}

interface SubmitReceiptBody {
  urlRecu: string
  purchaseAmountCents: number
}

const submitReceiptBodySchema = {
  type: 'object',
  required: ['urlRecu', 'purchaseAmountCents'],
  additionalProperties: false,
  properties: {
    urlRecu: { type: 'string', minLength: 1, maxLength: 2048 },
    purchaseAmountCents: { type: 'integer', minimum: 1 },
  },
} as const

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

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

const missionRoute: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
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

  // GET /api/missions/available — vitrine des missions à pourvoir pour un
  // voyageur : FUNDED et pas les siennes (on ne se propose pas ses propres
  // missions). Route statique : find-my-way la prioritise sur /:id.
  app.get('/available', async (req, reply) => {
    const missions = await prisma.mission.findMany({
      where: { status: MissionStatus.FUNDED, buyerId: { not: req.user.sub } },
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

  // POST /api/missions/:id/intent — financement T0, réservé à l'ACHETEUR.
  // Timeline (cf. workers/reconciliation.ts) : escrow HELD, capturedAmountCents 0,
  // ledger vide. La capture (T1/T2) viendra de la validation humaine + webhook.
  app.post('/:id/intent', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' }) // tiers/voyageur/inexistante : indistinguables

    // Prechecks AVANT l'appel Stripe : pas de PI créé pour une mission non finançable.
    const existingEscrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: mission.id },
      select: { id: true },
    })
    if (existingEscrow) return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
    if (mission.status !== MissionStatus.CREATED) {
      return reply.code(400).send({ error: 'MISSION_NOT_FUNDABLE' })
    }

    // Montant séquestré = budget + commission : la commission EST le frais
    // plateforme (le webhook de capture verse capturé − commission au voyageur).
    const totalAmountCents = mission.budgetCents + mission.commissionCents

    // Appel Stripe HORS transaction DB. idempotencyKey déterministe : deux
    // tentatives concurrentes ou un retry post-crash obtiennent le MÊME PI.
    const intent = await opts.stripe.paymentIntents.create(
      {
        amount: totalAmountCents,
        currency: 'eur',
        capture_method: 'manual', // séquestre : autorisation maintenant, capture après validation humaine
        metadata: { missionId: mission.id },
      },
      { idempotencyKey: `fund_${mission.id}` },
    )

    // Transaction atomique : transition conditionnelle (anti-TOCTOU) + escrow.
    // Soit les deux committent, soit rien — un échec laisse la mission CREATED
    // et le PI orphelin est récupéré tel quel au retry (idempotencyKey).
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.CREATED },
          data: { status: MissionStatus.FUNDED },
        })
        if (updated.count !== 1) throw new FundingConflictError()
        await tx.escrowTransaction.create({
          data: {
            missionId: mission.id,
            stripePaymentIntentId: intent.id,
            spendingLimitCents: mission.budgetCents, // plafond carte JIT = budget, figé
            idempotencyKey: `escrow_fund_${mission.id}`,
            // status HELD et capturedAmountCents 0 : défauts du schéma (T0)
          },
        })
      })
    } catch (err) {
      if (err instanceof FundingConflictError || isUniqueViolation(err)) {
        return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
      }
      throw err
    }

    return reply.code(200).send({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      amountCents: totalAmountCents,
    })
  })

  // POST /api/missions/:id/validate — validation humaine (T1), réservée à l'ACHETEUR.
  // Déclenche la capture du séquestre. Le reste (ledger CAPTURE/PAYOUT/COMMISSION,
  // escrow→RELEASED, TransferOutbox, mission→RELEASED) est porté par le webhook
  // payment_intent.succeeded — JAMAIS dupliqué ici (cf. timeline reconciliation.ts).
  app.post('/:id/validate', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' }) // tiers/voyageur/inexistante : indistinguables

    if (mission.status !== MissionStatus.AWAITING_VALIDATION) {
      // Inclut le 2e clic : la 1re validation a déjà posé VALIDATED.
      return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
    }
    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: mission.id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
    }

    // Capture HORS transaction DB. idempotencyKey déterministe : un retry
    // post-crash ou un double appel capture le MÊME PI une seule fois côté Stripe.
    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `capture_${mission.id}` },
    )

    // Transaction atomique : SEULE écriture = transition conditionnelle de la
    // mission (anti-TOCTOU). Aucune écriture comptable — le webhook s'en charge.
    // VALIDATED est transitoire : le webhook le finalisera en RELEASED.
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.AWAITING_VALIDATION },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new ValidationConflictError()
      })
    } catch (err) {
      if (err instanceof ValidationConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
      }
      throw err
    }

    const validated = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(validated)
  })

  // POST /api/missions/:id/match — un VOYAGEUR (pas l'acheteur) prend la mission.
  // La mission n'a pas encore de participant voyageur : autorisation par statut
  // FUNDED, pas par le helper participant (le candidat n'est pas encore lié).
  app.post('/:id/match', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user.sub
    const mission = await prisma.mission.findUnique({ where: { id } })
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
    // Un utilisateur ne peut pas accomplir sa propre mission.
    if (mission.buyerId === userId) {
      return reply.code(400).send({ error: 'CANNOT_MATCH_OWN_MISSION' })
    }
    if (mission.status !== MissionStatus.FUNDED) {
      // CREATED = pas encore finançée ; tout le reste = déjà prise/au-delà.
      const code =
        mission.status === MissionStatus.CREATED ? 'MISSION_NOT_MATCHABLE' : 'MISSION_ALREADY_MATCHED'
      return reply.code(400).send({ error: code })
    }

    // Transaction atomique : assignation conditionnelle (anti-TOCTOU). Deux
    // voyageurs concurrents : le 1er commit FUNDED → MATCHED, le 2nd voit
    // rowcount 0 (statut/travelerId ne matchent plus) → 400.
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id, status: MissionStatus.FUNDED, travelerId: null },
          data: { travelerId: userId, status: MissionStatus.MATCHED },
        })
        if (updated.count !== 1) throw new MatchConflictError()
      })
    } catch (err) {
      if (err instanceof MatchConflictError) {
        return reply.code(400).send({ error: 'MISSION_ALREADY_MATCHED' })
      }
      throw err
    }

    const matched = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(matched)
  })

  // POST /api/missions/:id/start-travel — le VOYAGEUR assigné passe à l'action.
  app.post(
    '/:id/start-travel',
    { schema: { params: missionIdParamsSchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' }) // acheteur/tiers : indistinguables

      // Transition conditionnelle MATCHED → IN_PROGRESS (anti-TOCTOU, anti double-départ).
      const updated = await prisma.mission.updateMany({
        where: { id, travelerId: req.user.sub, status: MissionStatus.MATCHED },
        data: { status: MissionStatus.IN_PROGRESS },
      })
      if (updated.count !== 1) {
        return reply.code(400).send({ error: 'MISSION_NOT_MATCHED' })
      }

      const started = await prisma.mission.findUniqueOrThrow({ where: { id } })
      return reply.code(200).send(started)
    },
  )

  // POST /api/missions/:id/submit-receipt — le VOYAGEUR scelle son reçu d'achat
  // et passe la mission en validation. Le reçu est IMMUABLE (Receipt.missionId
  // @unique) ; sha256 scellé côté serveur, horodatage serveur (jamais le device).
  app.post(
    '/:id/submit-receipt',
    { schema: { params: missionIdParamsSchema, body: submitReceiptBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' }) // acheteur/tiers : indistinguables
      if (mission.status !== MissionStatus.IN_PROGRESS) {
        // Couvre aussi le double dépôt : après le 1er, la mission est AWAITING_VALIDATION.
        return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
      }

      const { urlRecu, purchaseAmountCents } = req.body as SubmitReceiptBody
      // Un reçu ne peut pas dépasser le budget figé de la mission (le plafond
      // carte JIT l'aurait d'ailleurs refusé à l'achat — défense en profondeur).
      if (purchaseAmountCents > mission.budgetCents) {
        return reply.code(400).send({ error: 'RECEIPT_AMOUNT_EXCEEDS_BUDGET' })
      }
      // Hash content-addressed déterministe : scellé serveur (source de vérité).
      const sha256Server = createHash('sha256')
        .update(`${mission.id}:${urlRecu}:${purchaseAmountCents}`)
        .digest('hex')

      // Transaction atomique : reçu + transition conditionnelle. Tout rollback
      // ensemble si la mission a quitté IN_PROGRESS entre-temps (anti-TOCTOU).
      try {
        await prisma.$transaction(async tx => {
          await tx.receipt.create({
            data: {
              missionId: mission.id,
              totalTtcCents: purchaseAmountCents,
              receiptUrl: urlRecu,
              // Pas de hash client distinct dans ce flux : le serveur scelle.
              sha256Client: sha256Server,
              sha256Server,
              sealedAt: new Date(), // horloge serveur, jamais le device
            },
          })
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.IN_PROGRESS },
            data: { status: MissionStatus.AWAITING_VALIDATION },
          })
          if (updated.count !== 1) throw new ReceiptConflictError()
        })
      } catch (err) {
        if (err instanceof ReceiptConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
        }
        if (isUniqueViolation(err)) {
          return reply.code(400).send({ error: 'RECEIPT_ALREADY_SUBMITTED' }) // reçu immuable déjà scellé
        }
        throw err
      }

      const receipt = await prisma.receipt.findUniqueOrThrow({ where: { missionId: mission.id } })
      return reply.code(201).send(receipt)
    },
  )
}

export default missionRoute
