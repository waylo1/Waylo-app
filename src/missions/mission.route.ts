import { createHash } from 'node:crypto'
import { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../db'
import { EscrowStatus, MissionStatus, Prisma } from '../generated/prisma'
import {
  findMissionForBuyer,
  findMissionForParticipant,
  findMissionForTraveler,
} from './mission-access'
import { getCustomsThreshold } from './customs'
import { isRateLimited } from '../rate-limit'

/**
 * Garde ops/admin : autorisation par le flag `isAdmin` en base (source de
 * vérité unique, auditable, modifiable à chaud) — remplace l'ancienne allowlist
 * d'IDs portée par la variable d'environnement ADMIN_USER_IDS. Le voyageur
 * bénéficiaire n'a jamais ce flag. true uniquement si l'utilisateur existe ET
 * isAdmin === true ; tout autre cas (compte absent, flag false) → non-admin.
 */
async function isRequestAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  })
  return user?.isAdmin === true
}

/** preHandler de rate limit, clé par route + IP + utilisateur. 429 si dépassé. */
const rateLimit =
  (name: string) => async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (isRateLimited(`${name}:${req.ip}:${req.user.sub}`)) {
      await reply.code(429).send({ error: 'RATE_LIMITED' })
    }
  }

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
    /** Capture (T1) du séquestre — montant EXACT (amount_to_capture, centimes Int) ou total autorisé si omis. idempotencyKey déterministe par mission. */
    capture(
      id: string,
      params: { amount_to_capture?: number },
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
  /**
   * Surface Checkout — OPTIONNELLE : présente sur le SDK Stripe réel, omise par
   * les fakes du financement T0 (qui ne sollicitent que paymentIntents). La
   * session porte payment_intent_data.capture_method 'manual' → même séquestre
   * (capture différée) que /intent. La transition escrow HELD / mission FUNDED
   * reste portée par le webhook checkout.session.completed (hors périmètre ici).
   */
  checkout?: {
    sessions: {
      create(
        params: {
          mode: 'payment'
          line_items: Array<{
            price_data: {
              currency: string
              product_data: { name: string }
              unit_amount: number
            }
            quantity: number
          }>
          payment_intent_data: { capture_method: 'manual'; metadata: Record<string, string> }
          success_url: string
          cancel_url: string
          metadata: Record<string, string>
        },
        options: { idempotencyKey: string },
      ): Promise<{ id: string; url: string | null; payment_intent: string | { id: string } | null }>
    }
  }
}

export interface MissionRouteOptions {
  stripe: PaymentIntentClient
}

/** Transition AWAITING_VALIDATION → VALIDATED perdue (course / double validation). */
class ValidationConflictError extends Error {}

/** Transition FUNDED → MATCHED perdue (course : un autre voyageur a pris la mission). */
class MatchConflictError extends Error {}

/** Transition MATCHED → IN_PROGRESS perdue (course / double départ). */
class StartTravelConflictError extends Error {}

/** Transition IN_PROGRESS → AWAITING_VALIDATION perdue (course / double dépôt de reçu). */
class ReceiptConflictError extends Error {}

/** Transition IN_PROGRESS → VALIDATED perdue (course / double confirmation de réception). */
class ReceiveConflictError extends Error {}

/** Transition ESCROW_LOCKED_CUSTOMS → IN_PROGRESS perdue (course / double dépôt de quittance). */
class CustomsConflictError extends Error {}

interface CustomsReceiptBody {
  customsReceiptUrl: string
}

const customsReceiptBodySchema = {
  type: 'object',
  required: ['customsReceiptUrl'],
  additionalProperties: false,
  properties: {
    // Sécurise l'upload : URL http(s) pointant un PDF ou une image
    // (pdf/png/jpg/jpeg/webp), query string optionnelle. NB : la taille (< 5 Mo)
    // n'est PAS vérifiable ici — la route reçoit une URL, pas les octets ; un
    // fetch serveur exposerait au SSRF. À borner à l'upload (stockage objet).
    customsReceiptUrl: {
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      pattern: '^https?://.+\\.([pP][dD][fF]|[pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])(\\?.*)?$',
    },
  },
} as const

interface SubmitReceiptBody {
  urlRecu: string
  purchaseAmountCents: number
}

interface ShipBody {
  trackingReference: string
  purchaseAmountCents: number
}

const shipBodySchema = {
  type: 'object',
  required: ['trackingReference', 'purchaseAmountCents'],
  additionalProperties: false,
  properties: {
    trackingReference: { type: 'string', minLength: 1, maxLength: 200 },
    // Montant d'achat réel : base du contrôle douanier (scellé serveur ici).
    purchaseAmountCents: { type: 'integer', minimum: 1 },
  },
} as const

const submitReceiptBodySchema = {
  type: 'object',
  required: ['urlRecu', 'purchaseAmountCents'],
  additionalProperties: false,
  properties: {
    // Schéma http(s) obligatoire : rejette javascript:/data: (anti-XSS stocké,
    // le reçu est rendu en href côté acheteur).
    urlRecu: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://.+' },
    purchaseAmountCents: { type: 'integer', minimum: 1 },
  },
} as const

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

interface CreateMissionBody {
  targetProduct: string
  budgetCents: number
  commissionCents: number
  origin: string
  destination: string
  destinationCountry: string
  expiresAt: string
}

// budgetCents > 0, commissionCents ≥ 0 ; tous deux FIGÉS à la création
// (rules.md #4 : aucune route ne les modifie). expiresAt : format vérifié en
// applicatif (l'ajv de Fastify 4 n'embarque pas le format date-time).
const createMissionBodySchema = {
  type: 'object',
  required: [
    'targetProduct',
    'budgetCents',
    'commissionCents',
    'origin',
    'destination',
    'destinationCountry',
    'expiresAt',
  ],
  additionalProperties: false,
  properties: {
    targetProduct: { type: 'string', minLength: 1, maxLength: 500 },
    budgetCents: { type: 'integer', minimum: 1 },
    commissionCents: { type: 'integer', minimum: 0 },
    origin: { type: 'string', minLength: 1, maxLength: 200 },
    destination: { type: 'string', minLength: 1, maxLength: 200 },
    // Code pays ISO-2 du pays de destination — REQUIS : pilote le seuil douanier
    // (fail-safe, plus de contrôle inerte). Normalisé en majuscules côté route.
    destinationCountry: { type: 'string', pattern: '^[A-Za-z]{2}$' },
    expiresAt: { type: 'string', minLength: 1 },
  },
} as const

const missionIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const

// Filtres optionnels du catalogue FUNDED (recherche insensible à la casse).
const availableQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    origin: { type: 'string', maxLength: 200 },
    destination: { type: 'string', maxLength: 200 },
  },
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
        origin: body.origin,
        destination: body.destination,
        destinationCountry: body.destinationCountry.toUpperCase(),
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
  // missions). Filtres optionnels origin/destination (contains, insensible à la
  // casse). Route statique : find-my-way la prioritise sur /:id.
  app.get(
    '/available',
    { schema: { querystring: availableQuerySchema } },
    async (req, reply) => {
      const { origin, destination } = req.query as { origin?: string; destination?: string }
      const where: Prisma.MissionWhereInput = {
        status: MissionStatus.FUNDED,
        buyerId: { not: req.user.sub },
      }
      if (origin) where.origin = { contains: origin, mode: 'insensitive' }
      if (destination) where.destination = { contains: destination, mode: 'insensitive' }
      const missions = await prisma.mission.findMany({ where, orderBy: { createdAt: 'desc' } })
      return reply.code(200).send(missions)
    },
  )

  // GET /api/missions/:id — visible par l'acheteur OU le voyageur assigné ;
  // tiers → 404 (ne révèle pas l'existence). Le reçu scellé (s'il existe) est
  // joint sous `receipt`, restreint aux champs exposables (totalTtcCents,
  // receiptUrl, sealedAt) — jamais les sha256, détail d'implémentation du
  // scellement.
  app.get('/:id', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const access = await findMissionForParticipant(prisma, id, req.user.sub)
    if (!access) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
    const mission = await prisma.mission.findUniqueOrThrow({
      where: { id },
      include: {
        receipt: {
          select: { totalTtcCents: true, receiptUrl: true, sealedAt: true },
        },
      },
    })
    return reply.code(200).send(mission)
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

    // RÉSERVATION ATOMIQUE avant tout appel Stripe. /intent et /checkout-session
    // se disputent la MÊME transition CREATED → FUNDED : le perdant échoue ICI,
    // avant de créer le moindre PaymentIntent → jamais deux séquestres/holds.
    const reserved = await prisma.mission.updateMany({
      where: { id: mission.id, status: MissionStatus.CREATED },
      data: { status: MissionStatus.FUNDED },
    })
    if (reserved.count !== 1) {
      return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
    }

    try {
      // idempotencyKey déterministe : un retry post-crash récupère le MÊME PI.
      const intent = await opts.stripe.paymentIntents.create(
        {
          amount: totalAmountCents,
          currency: 'eur',
          capture_method: 'manual', // séquestre : autorisation maintenant, capture après validation
          metadata: { missionId: mission.id },
        },
        { idempotencyKey: `fund_${mission.id}` },
      )
      await prisma.escrowTransaction.create({
        data: {
          missionId: mission.id,
          stripePaymentIntentId: intent.id,
          spendingLimitCents: mission.budgetCents, // plafond carte JIT = budget, figé
          idempotencyKey: `escrow_fund_${mission.id}`,
          // status HELD et capturedAmountCents 0 : défauts du schéma (T0)
        },
      })
      return reply.code(200).send({
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        amountCents: totalAmountCents,
      })
    } catch (err) {
      // Échec Stripe/escrow : on RELÂCHE la réservation (FUNDED → CREATED) pour
      // permettre un retry — aucun escrow n'a été committé dans ce chemin.
      await prisma.mission.updateMany({
        where: { id: mission.id, status: MissionStatus.FUNDED },
        data: { status: MissionStatus.CREATED },
      })
      if (isUniqueViolation(err)) {
        return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
      }
      throw err
    }
  })

  // POST /api/missions/:id/checkout-session — financement T0 via Stripe Checkout
  // (page hébergée), alternative à /intent. UNIFIÉ avec /intent : même réservation
  // atomique CREATED → FUNDED, même escrow HELD créé SYNCHRONEMENT à partir du
  // PaymentIntent de la session (un seul PI déterministe par mission). Le webhook
  // checkout.session.completed devient un simple acquittement (escrow déjà posé).
  app.post(
    '/:id/checkout-session',
    { schema: { params: missionIdParamsSchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' }) // tiers/voyageur/inexistante : indistinguables

      const existingEscrow = await prisma.escrowTransaction.findUnique({
        where: { missionId: mission.id },
        select: { id: true },
      })
      if (existingEscrow) return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
      if (mission.status !== MissionStatus.CREATED) {
        return reply.code(400).send({ error: 'MISSION_NOT_FUNDABLE' })
      }
      if (!opts.stripe.checkout) return reply.code(500).send({ error: 'CHECKOUT_UNAVAILABLE' })

      // Prix = budget + commission (frais plateforme), centimes Int — miroir de /intent.
      const totalAmountCents = mission.budgetCents + mission.commissionCents
      const frontendBaseUrl = process.env.FRONTEND_BASE_URL ?? 'http://localhost:3001'

      // Réservation atomique AVANT l'appel Stripe (cf. /intent) : exclut tout
      // financement concurrent par l'autre chemin → pas de double hold.
      const reserved = await prisma.mission.updateMany({
        where: { id: mission.id, status: MissionStatus.CREATED },
        data: { status: MissionStatus.FUNDED },
      })
      if (reserved.count !== 1) {
        return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
      }

      try {
        const session = await opts.stripe.checkout.sessions.create(
          {
            mode: 'payment',
            line_items: [
              {
                price_data: {
                  currency: 'eur',
                  product_data: { name: mission.targetProduct },
                  unit_amount: totalAmountCents,
                },
                quantity: 1,
              },
            ],
            payment_intent_data: { capture_method: 'manual', metadata: { missionId: mission.id } },
            success_url: `${frontendBaseUrl}/missions/${mission.id}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontendBaseUrl}/missions/${mission.id}?checkout=cancel`,
            metadata: { missionId: mission.id },
          },
          { idempotencyKey: `checkout_${mission.id}` },
        )

        // PI de la session = source de vérité de l'escrow (un seul PI par mission).
        const piId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id
        if (!piId) throw new Error('CHECKOUT_NO_PAYMENT_INTENT')

        await prisma.escrowTransaction.create({
          data: {
            missionId: mission.id,
            stripePaymentIntentId: piId,
            spendingLimitCents: mission.budgetCents,
            idempotencyKey: `escrow_fund_${mission.id}`,
          },
        })
        return reply.code(200).send({ checkoutUrl: session.url, sessionId: session.id })
      } catch (err) {
        // Relâche la réservation pour permettre un retry (aucun escrow committé).
        await prisma.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.FUNDED },
          data: { status: MissionStatus.CREATED },
        })
        if (isUniqueViolation(err)) {
          return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
        }
        throw err
      }
    },
  )

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

  // POST /api/missions/:id/receive — l'ACHETEUR confirme la réception du colis
  // (depuis IN_PROGRESS). Déclenche la CAPTURE du séquestre (capture différée).
  // Le virement du gain au voyageur N'EST PAS fait ici : le webhook
  // payment_intent.succeeded journalise PAYOUT/COMMISSION + crée le TransferOutbox,
  // et le worker (seul exécutant des versements) exécute le transfert Stripe.
  // IN_PROGRESS → VALIDATED (transitoire) ; le webhook finalise → RELEASED (statut final).
  app.post('/:id/receive', { schema: { params: missionIdParamsSchema }, preHandler: rateLimit('receive') }, async (req, reply) => {
    const { id } = req.params as { id: string }
    // Contrôle d'accès (MASQUAGE TOTAL) : 404 si la mission n'existe pas OU si
    // l'utilisateur n'est pas l'Acheteur Final (buyer) — les deux cas sont
    // indistinguables, l'existence de la mission n'est jamais révélée à un tiers.
    const mission = await prisma.mission.findUnique({ where: { id } })
    if (!mission || mission.buyerId !== req.user.sub) {
      return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
    }

    if (mission.status !== MissionStatus.IN_PROGRESS) {
      return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
    }

    // Contrôle douanier : si un pays de destination est connu, que la quittance
    // n'a pas encore été fournie et que la valeur déclarée (= budget des biens)
    // dépasse le seuil de minimis, on BLOQUE la prime AVANT toute capture —
    // l'argent de l'acheteur n'est pas prélevé tant que les taxes ne sont pas
    // prouvées (cf. POST /:id/customs-receipt qui lève le verrou).
    if (mission.destinationCountry && !mission.customsReceiptUrl) {
      const thresholdCents = getCustomsThreshold(mission.destinationCountry) * 100
      // Base = montant d'achat RÉEL scellé par le voyageur (/ship), pas le budget
      // déclaratif de l'acheteur → bloque la sous-déclaration. Fallback budget si absent.
      const declaredCents = mission.purchaseAmountCents ?? mission.budgetCents
      if (declaredCents > thresholdCents) {
        const locked = await prisma.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.IN_PROGRESS },
          data: { status: MissionStatus.ESCROW_LOCKED_CUSTOMS },
        })
        if (locked.count !== 1) {
          return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
        }
        const lockedMission = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
        return reply.code(200).send(lockedMission)
      }
    }

    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: mission.id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
    }

    // Capture HORS transaction DB. idempotencyKey déterministe partagée avec
    // /validate → un seul débit par mission quel que soit le chemin.
    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `capture_${mission.id}` },
    )

    // Certificat de revente électronique (modèle marchand v8.0, revente
    // intermédiée) : ID transaction, Voyageur Importateur, Acheteur Final, prix
    // d'achat et Marge Voyageur. Scellé sha256, stocké dans saleSignature.
    const saleCertificate = JSON.stringify({
      transactionId: mission.id,
      voyageurImportateurId: mission.travelerId,
      acheteurFinalId: mission.buyerId,
      prixAchatCents: mission.budgetCents,
      margeCents: mission.commissionCents,
    })
    const saleSignature = createHash('sha256').update(saleCertificate).digest('hex')

    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.IN_PROGRESS },
          data: { status: MissionStatus.VALIDATED, saleSignature },
        })
        if (updated.count !== 1) throw new ReceiveConflictError()
      })
    } catch (err) {
      if (err instanceof ReceiveConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
      }
      throw err
    }

    const received = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(received)
  })

  // POST /api/missions/:id/customs-receipt — le VOYAGEUR téléverse sa preuve de
  // paiement des taxes. Scellé serveur (sha256). Transition conditionnelle
  // ESCROW_LOCKED_CUSTOMS → PENDING_CUSTOMS_REVIEW : le bénéficiaire NE lève PAS
  // son propre verrou ; une validation ops/admin (/customs-approve) est requise
  // pour repasser en IN_PROGRESS.
  app.post(
    '/:id/customs-receipt',
    {
      schema: { params: missionIdParamsSchema, body: customsReceiptBodySchema },
      preHandler: rateLimit('customs-receipt'),
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      // Contrôle d'accès (MASQUAGE TOTAL) : 404 si la mission n'existe pas OU si
      // l'utilisateur n'est pas le Voyageur Importateur (traveler) assigné — les
      // deux cas indistinguables, l'existence n'est jamais révélée à un tiers.
      const mission = await prisma.mission.findUnique({ where: { id } })
      if (!mission || mission.travelerId !== req.user.sub) {
        return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
      }
      if (mission.status !== MissionStatus.ESCROW_LOCKED_CUSTOMS) {
        return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_LOCKED' })
      }

      const { customsReceiptUrl } = req.body as CustomsReceiptBody
      const sha256 = createHash('sha256').update(`${mission.id}:${customsReceiptUrl}`).digest('hex')

      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.ESCROW_LOCKED_CUSTOMS },
            data: {
              status: MissionStatus.PENDING_CUSTOMS_REVIEW,
              customsReceiptUrl,
              customsReceiptSha256: sha256,
            },
          })
          if (updated.count !== 1) throw new CustomsConflictError()
        })
      } catch (err) {
        if (err instanceof CustomsConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_LOCKED' })
        }
        throw err
      }

      const reviewing = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply.code(200).send(reviewing)
    },
  )

  // POST /api/missions/:id/customs-approve — validation ops/admin du verrou
  // douanier : PENDING_CUSTOMS_REVIEW → IN_PROGRESS. Réservé aux comptes
  // isAdmin (le voyageur bénéficiaire en est exclu). 403 sinon.
  app.post('/:id/customs-approve', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      return reply.code(403).send({ error: 'FORBIDDEN' })
    }
    const { id } = req.params as { id: string }
    const updated = await prisma.mission.updateMany({
      where: { id, status: MissionStatus.PENDING_CUSTOMS_REVIEW },
      data: { status: MissionStatus.IN_PROGRESS },
    })
    if (updated.count !== 1) {
      return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_REVIEW' })
    }
    const approved = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(approved)
  })

  // POST /api/missions/:id/customs-reject — l'admin rejette la quittance soumise :
  // PENDING_CUSTOMS_REVIEW → ESCROW_LOCKED_CUSTOMS. Efface customsReceiptUrl/sha256
  // pour que le voyageur puisse soumettre un nouveau document. Admin-only.
  app.post('/:id/customs-reject', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      return reply.code(403).send({ error: 'FORBIDDEN' })
    }
    const { id } = req.params as { id: string }
    const updated = await prisma.mission.updateMany({
      where: { id, status: MissionStatus.PENDING_CUSTOMS_REVIEW },
      data: {
        status: MissionStatus.ESCROW_LOCKED_CUSTOMS,
        customsReceiptUrl: null,
        customsReceiptSha256: null,
      },
    })
    if (updated.count !== 1) {
      return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_REVIEW' })
    }
    const rejected = await prisma.mission.findUniqueOrThrow({ where: { id } })
    // Stub notification : log structuré consommable par un futur service d'alertes
    // voyageur (email/push). Le travelerId est la cible ; missionId la référence.
    req.log.info(
      { missionId: id, travelerId: rejected.travelerId, event: 'CUSTOMS_RECEIPT_REJECTED' },
      'customs: quittance refusée — voyageur à notifier',
    )
    return reply.code(200).send(rejected)
  })

  // GET /api/missions/customs-pending — liste des missions PENDING_CUSTOMS_REVIEW.
  // Réservé aux comptes isAdmin. Retourne id, montants, quittance déposée par le
  // voyageur (URL + sha256) et le pays de destination.
  app.get('/customs-pending', async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      return reply.code(403).send({ error: 'FORBIDDEN' })
    }
    const missions = await prisma.mission.findMany({
      where: { status: MissionStatus.PENDING_CUSTOMS_REVIEW },
      select: {
        id: true,
        budgetCents: true,
        purchaseAmountCents: true,
        destinationCountry: true,
        customsReceiptUrl: true,
        customsReceiptSha256: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
    })
    return reply.code(200).send(missions)
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

  // POST /api/missions/:id/accept — un VOYAGEUR (pas l'acheteur) accepte le
  // transport. « ASSIGNED » dans le langage produit = statut MATCHED de l'enum
  // (label « Voyageur assigné ») ; aucune valeur ASSIGNED n'existe — on ne
  // duplique pas MATCHED. Même transition sûre que /match : FUNDED + travelerId
  // null → MATCHED + travelerId, conditionnelle et atomique (anti-TOCTOU).
  app.post('/:id/accept', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user.sub
    const mission = await prisma.mission.findUnique({ where: { id } })
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
    if (mission.buyerId === userId) {
      return reply.code(400).send({ error: 'CANNOT_MATCH_OWN_MISSION' })
    }
    if (mission.status !== MissionStatus.FUNDED) {
      const code =
        mission.status === MissionStatus.CREATED ? 'MISSION_NOT_MATCHABLE' : 'MISSION_ALREADY_MATCHED'
      return reply.code(400).send({ error: code })
    }

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

    const accepted = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(accepted)
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

  // POST /api/missions/:id/ship — le VOYAGEUR assigné déclare le dépôt/expédition
  // (trackingReference) et fait avancer la mission au statut de livraison
  // supérieur : MATCHED → IN_PROGRESS. Transition conditionnelle atomique
  // (anti-TOCTOU). Recouvre /start-travel, mais enregistre en plus la référence.
  app.post(
    '/:id/ship',
    { schema: { params: missionIdParamsSchema, body: shipBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' }) // acheteur/tiers : indistinguables
      if (mission.status !== MissionStatus.MATCHED) {
        return reply.code(400).send({ error: 'MISSION_NOT_MATCHED' })
      }

      const { trackingReference, purchaseAmountCents } = req.body as ShipBody
      // Le montant d'achat scellé ne peut excéder le budget figé (le plafond carte
      // JIT l'aurait refusé) — défense en profondeur contre la sur-déclaration.
      if (purchaseAmountCents > mission.budgetCents) {
        return reply.code(400).send({ error: 'RECEIPT_AMOUNT_EXCEEDS_BUDGET' })
      }
      const updated = await prisma.mission.updateMany({
        where: { id, travelerId: req.user.sub, status: MissionStatus.MATCHED },
        data: { status: MissionStatus.IN_PROGRESS, trackingReference, purchaseAmountCents },
      })
      if (updated.count !== 1) {
        return reply.code(400).send({ error: 'MISSION_NOT_MATCHED' })
      }

      const shipped = await prisma.mission.findUniqueOrThrow({ where: { id } })
      return reply.code(200).send(shipped)
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
