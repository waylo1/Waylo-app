import { createHash, randomBytes } from 'node:crypto'
import { FastifyError, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../db'
import { DropOffType, EscrowStatus, MissionStatus, Prisma, SubstitutionStatus } from '../generated/prisma'
import {
  findMissionForBuyer,
  findMissionForParticipant,
  findMissionForTraveler,
} from './mission-access'
import { getCustomsThreshold } from './customs'
import { hashQrCode, qrCodeMatches } from './qr-proof'
import { isRateLimited, maskIp } from '../rate-limit'
import { safeEmit, type AlertSink } from '../alerts'
import {
  validateMissionFunding,
  requiredCapacityCents,
  CheckoutValidationError,
} from '../checkout/wallet-validation'

/**
 * Garde ops/admin : autorisation par le flag `isAdmin` en base (source de
 * vérité unique, auditable, modifiable à chaud) — remplace l'ancienne allowlist
 * d'IDs portée par la variable d'environnement ADMIN_USER_IDS. Le voyageur
 * bénéficiaire n'a jamais ce flag. true uniquement si l'utilisateur existe ET
 * isAdmin === true ; tout autre cas (compte absent, flag false) → non-admin.
 */
export async function isRequestAdmin(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  })
  return user?.isAdmin === true
}

/**
 * Garde « carte de garantie » voyageur : un voyageur ne peut prendre/accepter une
 * mission que si une carte (payment method Stripe) a été enregistrée à l'inscription.
 * Cette carte est la garantie qui adossera la ponction de pénalité en cas de fraude
 * (arbitrage admin, sprint dédié). Absence ⇒ acceptation refusée (400
 * TRAVELER_CARD_MISSING). Lookup frais en base, comme isRequestAdmin.
 */
async function travelerHasGuaranteeCard(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripePaymentMethodId: true },
  })
  return Boolean(user?.stripePaymentMethodId)
}

/** preHandler de rate limit, clé par route + IP + utilisateur. 429 si dépassé. */
const rateLimit =
  (name: string) => async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (await isRateLimited(`${name}:${maskIp(req.ip)}:${req.user.sub}`)) {
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
    /**
     * Annule un PaymentIntent HELD non capturé (arbitrage refund admin §8). Le
     * hold n'a jamais été débité (litige ouvert depuis DEPOSITED) : on ANNULE,
     * on ne rembourse pas une capture inexistante — miroir du timeout douanier
     * (reconciliation.ts §6). OPTIONNELLE comme `checkout` : présente sur le SDK
     * réel, omise par les fakes qui ne l'exercent pas. Signature 3-arg
     * (id, params, options) = SDK Stripe réel : idempotencyKey en options.
     */
    cancel?(
      id: string,
      params: Record<string, never>,
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
  /** Hook d'alertes opérationnelles (cf. src/alerts.ts). Défaut : log structuré stderr. */
  onAlert?: AlertSink
}

/** Transition AWAITING_VALIDATION → VALIDATED perdue (course / double validation). */
class ValidationConflictError extends Error {}

/** Transition AWAITING_VALIDATION → VALIDATED perdue via /confirm-receipt (course / double confirmation). */
class ConfirmReceiptConflictError extends Error {}

/** Transition FUNDED → MATCHED perdue (course : un autre voyageur a pris la mission). */
class MatchConflictError extends Error {}


/** Transition IN_PROGRESS → AWAITING_VALIDATION perdue (course / double dépôt de reçu). */
class ReceiptConflictError extends Error {}

/** Transition IN_PROGRESS → VALIDATED perdue (course / double confirmation de réception). */
class ReceiveConflictError extends Error {}

/** Transition ESCROW_LOCKED_CUSTOMS → IN_PROGRESS perdue (course / double dépôt de quittance). */
class CustomsConflictError extends Error {}

/** Transition PENDING_CUSTOMS_REVIEW → (IN_PROGRESS | ESCROW_LOCKED_CUSTOMS) perdue (course / double décision ops). */
class CustomsReviewConflictError extends Error {}

/** Transition {MATCHED | VALIDATED} → DEPOSITED perdue (course / double dépôt de colis). */
class DropoffConflictError extends Error {}

/** Transition DEPOSITED → VALIDATED perdue (course / double confirmation de collecte). */
class CollectionConflictError extends Error {}

/** Transition DEPOSITED → DISPUTED perdue (course / collecte confirmée entre-temps). */
class DisputeConflictError extends Error {}

/** Transition DISPUTED → CANCELLED perdue (course / litige déjà arbitré). */
class ResolveRefundConflictError extends Error {}

/** Transition DISPUTED → VALIDATED perdue (course / litige déjà arbitré). */
class ResolvePayoutConflictError extends Error {}

/** Mission introuvable ou appelant non voyageur assigné lors du drop-off (404 masquant). */
class LogisticsDropOffNotFoundError extends Error {}
/** Mission pas IN_PROGRESS lors du drop-off logistique. */
class LogisticsDropOffStatusError extends Error {}
/** Transition IN_PROGRESS → AWAITING_VALIDATION (drop-off logistique) perdue (course). */
class LogisticsDropOffConflictError extends Error {}
/** Mission introuvable ou appelant non participant (404 masquant). */
class ReviewNotFoundError extends Error {}
/** Mission pas dans un statut terminal (RELEASED ou CANCELLED). */
class ReviewNotTerminalError extends Error {}
/** Acheteur essaie de noter alors qu'aucun voyageur n'est assigné. */
class ReviewNoTravelerError extends Error {}

interface DropOffBody {
  dropOffType: DropOffType
  dropOffCarrier: string
  dropOffTrackingId: string
  dropOffAccessCode?: string
}

const dropOffBodySchema = {
  type: 'object',
  required: ['dropOffType', 'dropOffCarrier', 'dropOffTrackingId'],
  additionalProperties: false,
  properties: {
    dropOffType: { type: 'string', enum: ['LOCKER', 'RELAY', 'POSTAL'] },
    dropOffCarrier: { type: 'string', minLength: 1, maxLength: 200 },
    dropOffTrackingId: { type: 'string', minLength: 1, maxLength: 200 },
    // Optionnel : code secret d'un casier. Borné (anti-abus de payload).
    dropOffAccessCode: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const

interface ReviewBody {
  rating: number
  comment?: string
}

const reviewBodySchema = {
  type: 'object',
  required: ['rating'],
  additionalProperties: false,
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    // Commentaire libre borné (anti-abus de payload ; texte brut, pas d'URL stockée).
    comment: { type: 'string', minLength: 1, maxLength: 2000 },
  },
} as const

interface CustomsReceiptBody {
  customsReceiptUrl: string
  customsReceiptSha256: string
}

const customsReceiptBodySchema = {
  type: 'object',
  required: ['customsReceiptUrl', 'customsReceiptSha256'],
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
    // sha256 hex des octets du document calculé côté client avant upload —
    // scellement content-addressed : l'admin peut vérifier le hash contre le
    // document téléchargé depuis customsReceiptUrl.
    customsReceiptSha256: {
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    },
  },
} as const

interface SubmitReceiptBody {
  urlRecu: string
  purchaseAmountCents: number
}

interface DropoffReceiptBody {
  dropoffReceiptUrl: string
  dropoffTrackingNumber?: string
}

const dropoffReceiptBodySchema = {
  type: 'object',
  required: ['dropoffReceiptUrl'],
  additionalProperties: false,
  properties: {
    // Schéma http(s) obligatoire : rejette javascript:/data: (anti-XSS stocké,
    // la preuve de dépôt est rendue en href). Pas de fetch serveur de l'URL (anti-SSRF).
    dropoffReceiptUrl: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://.+' },
    // Numéro de suivi transporteur — optionnel, borné (anti-abus de payload).
    dropoffTrackingNumber: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const

interface DisputeBody {
  disputeReason?: string
}

const disputeBodySchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    // Motif libre OPTIONNEL — borné (anti-abus de payload). Pas d'URL ici : texte brut.
    disputeReason: { type: 'string', minLength: 1, maxLength: 2000 },
  },
} as const
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

/**
 * Plafond « Drive » (S16/S17) : 120% du budget, centimes Int strict (Math.floor,
 * jamais Float). Source unique pour (a) le plafond de reçu de substitution
 * (/submit-receipt), (b) le dimensionnement du séquestre acheteur + du Spending
 * Control JIT au financement quand la substitution est pré-autorisée.
 */
export const substitutionCeilingCents = (budgetCents: number): number =>
  Math.floor((budgetCents * 12) / 10)

/** Corps OPTIONNEL des routes de financement : capacité carte déclarée par l'acheteur. */
interface FundingBody {
  /**
   * Montant que la carte de l'acheteur autorisera au checkout (centimes Int ≥ 0).
   * OMIS ⇒ on suppose que la carte couvre le plafond requis (120% du total) : la
   * garde passe (comportement historique). Une valeur explicite < plafond force
   * le Wallet interne à combler le delta, sinon INSUFFICIENT_FUNDS_FOR_MISSION.
   */
  stripeAuthorizationCents?: number
}

/**
 * Garde capacité « Drive » (S19), PARTAGÉE par /intent et /checkout-session.
 * Pré-vol PUR (aucune écriture, aucun appel Stripe, ne modifie pas le hold) :
 * (autorisation carte acheteur + solde Wallet interne) doit atteindre 120% du
 * prix total mission (cf. validateMissionFunding). Capacité carte par défaut =
 * plafond requis ⇒ passe sans Wallet (non-régression du financement nominal).
 * Renvoie { status, code } à répondre si insuffisant, ou null si OK.
 */
async function checkFundingCapacity(
  missionId: string,
  budgetCents: number,
  commissionCents: number,
  declaredAuthCents: number | undefined,
): Promise<{ status: number; code: string } | null> {
  const stripeAuthorizationCents =
    declaredAuthCents ?? requiredCapacityCents(budgetCents + commissionCents)
  try {
    await validateMissionFunding({ missionId, stripeAuthorizationCents })
    return null
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      return { status: err.code === 'MISSION_NOT_FOUND' ? 404 : 400, code: err.code }
    }
    throw err
  }
}

interface CreateMissionBody {
  targetProduct: string
  budgetCents: number
  commissionCents: number
  origin: string
  destination: string
  destinationCountry: string
  expiresAt: string
  substitutionAuthorized?: boolean
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
    // Pré-autorisation « Drive » (S16) — OPTIONNELLE, défaut false côté route/DB :
    // l'acheteur consent dès la commande à un reçu de substitution jusqu'à 120% du budget.
    substitutionAuthorized: { type: 'boolean' },
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
  app.setErrorHandler((err: FastifyError, req, reply) => {
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
        substitutionAuthorized: body.substitutionAuthorized ?? false, // pré-autorisation Drive (S16)
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

    // Garde capacité « Drive » (S19) AVANT toute réservation/appel Stripe : si la
    // capacité (carte + Wallet) ne couvre pas 120% du total, on bloque ici.
    const intentBody = (req.body ?? {}) as FundingBody
    const intentCapacityError = await checkFundingCapacity(
      mission.id,
      mission.budgetCents,
      mission.commissionCents,
      intentBody.stripeAuthorizationCents,
    )
    if (intentCapacityError) {
      return reply.code(intentCapacityError.status).send({ error: intentCapacityError.code })
    }

    // Montant séquestré = budget + commission : la commission EST le frais
    // plateforme (le webhook de capture verse capturé − commission au voyageur).
    // Modèle « Drive » (S17) : si la substitution est pré-autorisée, l'acheteur
    // consent à un surcoût jusqu'à 120% du budget → le hold ET le plafond carte JIT
    // sont dimensionnés à 120%. La commission (frais plateforme) reste INCHANGÉE.
    const heldBudgetCents = mission.substitutionAuthorized
      ? substitutionCeilingCents(mission.budgetCents)
      : mission.budgetCents
    const totalAmountCents = heldBudgetCents + mission.commissionCents

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
          spendingLimitCents: heldBudgetCents, // plafond carte JIT = budget (ou 120% si substitution pré-autorisée), figé
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

      // Garde capacité « Drive » (S19), miroir exact de /intent : (carte + Wallet)
      // ≥ 120% du total, sinon 400 AVANT toute réservation/appel Stripe.
      const checkoutBody = (req.body ?? {}) as FundingBody
      const checkoutCapacityError = await checkFundingCapacity(
        mission.id,
        mission.budgetCents,
        mission.commissionCents,
        checkoutBody.stripeAuthorizationCents,
      )
      if (checkoutCapacityError) {
        return reply.code(checkoutCapacityError.status).send({ error: checkoutCapacityError.code })
      }

      // Prix = budget + commission (frais plateforme), centimes Int — miroir de /intent.
      // Modèle « Drive » (S17) : hold dimensionné à 120% du budget si substitution
      // pré-autorisée (commission inchangée).
      const heldBudgetCents = mission.substitutionAuthorized
        ? substitutionCeilingCents(mission.budgetCents)
        : mission.budgetCents
      const totalAmountCents = heldBudgetCents + mission.commissionCents
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
            spendingLimitCents: heldBudgetCents, // = budget, ou 120% si substitution pré-autorisée
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

    // Garde douane (D4) : une mission en revue douanière (verrou posé par /receive
    // ou quittance en attente de validation ops) ne peut JAMAIS être validée —
    // 409 explicite AVANT tout appel Stripe : aucune capture tant que /customs-approve
    // n'a pas levé le verrou. Précède le check de statut générique pour donner un
    // code métier précis plutôt qu'un MISSION_NOT_AWAITING_VALIDATION trompeur.
    if (
      mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
      mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
    ) {
      return reply.code(409).send({ error: 'CUSTOMS_REVIEW_PENDING' })
    }

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

  // POST /api/missions/:id/confirm-receipt — confirmation de réception par l'ACHETEUR.
  // JUMEAU de /validate (même état d'entrée AWAITING_VALIDATION, même effet) : déclenche
  // la CAPTURE du séquestre, jamais le versement. Le ledger PAYOUT/COMMISSION, le
  // TransferOutbox, escrow→RELEASED et mission→RELEASED sont portés par le webhook
  // payment_intent.succeeded — JAMAIS dupliqués ici (règle d'or §5 + invariants ledger §3).
  // Clé de capture PARTAGÉE `capture_<id>` : un acheteur qui appelle /validate ET
  // /confirm-receipt ne capture qu'UNE fois côté Stripe (idempotence déterministe).
  app.post('/:id/confirm-receipt', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' }) // tiers/voyageur/inexistante : indistinguables

    // Garde douane (miroir de /validate) : une mission sous verrou douanier ne peut
    // être confirmée — 409 explicite AVANT tout appel Stripe, code métier précis.
    if (
      mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
      mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
    ) {
      return reply.code(409).send({ error: 'CUSTOMS_REVIEW_PENDING' })
    }

    if (mission.status !== MissionStatus.AWAITING_VALIDATION) {
      // Inclut le 2e clic : la 1re confirmation/validation a déjà posé VALIDATED.
      return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
    }
    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: mission.id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
    }

    // Capture HORS transaction DB (règle d'or). Clé partagée avec /validate :
    // capture idempotente du MÊME PaymentIntent quel que soit le chemin acheteur.
    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `capture_${mission.id}` },
    )

    // Transaction atomique : SEULE écriture = transition conditionnelle (anti-TOCTOU).
    // Aucune écriture comptable — le webhook journalise PAYOUT/COMMISSION + outbox.
    // VALIDATED est transitoire : le webhook le finalisera en RELEASED.
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.AWAITING_VALIDATION },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new ConfirmReceiptConflictError()
      })
    } catch (err) {
      if (err instanceof ConfirmReceiptConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
      }
      throw err
    }

    const confirmed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(confirmed)
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

      const { customsReceiptUrl, customsReceiptSha256 } = req.body as CustomsReceiptBody

      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.ESCROW_LOCKED_CUSTOMS },
            data: {
              status: MissionStatus.PENDING_CUSTOMS_REVIEW,
              customsReceiptUrl,
              customsReceiptSha256,
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
  // douanier : PENDING_CUSTOMS_REVIEW → VALIDATED (transitoire, clôture financière).
  // Réservé aux comptes isAdmin (le voyageur bénéficiaire en est exclu). 403 sinon.
  //
  // Le buyer a déjà confirmé la réception (/receive → ESCROW_LOCKED_CUSTOMS) : la
  // résolution douanière déclenche directement la capture Stripe et positionne la
  // mission en VALIDATED. Le webhook payment_intent.succeeded finalise en RELEASED
  // (ledger CAPTURE/PAYOUT/COMMISSION + TransferOutbox) — jamais dupliqué ici.
  //
  // Ordre : escrow lookup → capture Stripe HORS tx (règle d'or) → $transaction
  // atomique (transition + audit). Un retry admin après crash re-présente la même
  // idempotencyKey à Stripe (idempotent, un seul débit) puis réessaie la $tx.
  app.post('/:id/customs-approve', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      return reply.code(403).send({ error: 'FORBIDDEN' })
    }
    const { id } = req.params as { id: string }

    // Vérification de l'escrow AVANT la capture — HORS transaction (règle d'or).
    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
    }

    // Capture HORS transaction DB — même motif que /validate et /receive.
    // Clé déterministe distincte du chemin buyer : un retry après un crash entre
    // la capture et la $transaction ré-utilise la même clé → idempotent côté Stripe.
    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `capture_customs_${id}` },
    )

    // Transition + audit ATOMIQUES (D-c) : la décision ops et sa trace
    // AdminAuditLog committent ensemble ou pas du tout. Statut cible VALIDATED
    // (transitoire) : le webhook payment_intent.succeeded finalise en RELEASED.
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id, status: MissionStatus.PENDING_CUSTOMS_REVIEW },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new CustomsReviewConflictError()
        await tx.adminAuditLog.create({
          data: { adminId: req.user.sub, action: 'CUSTOMS_APPROVE', missionId: id },
        })
      })
    } catch (err) {
      if (err instanceof CustomsReviewConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_REVIEW' })
      }
      throw err
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
    // Transition + audit ATOMIQUES (D-c), même motif que customs-approve : le
    // nettoyage de la quittance, le retour en verrou et la trace d'audit
    // committent ensemble ou pas du tout. Transition conditionnelle (anti-TOCTOU).
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id, status: MissionStatus.PENDING_CUSTOMS_REVIEW },
          data: {
            status: MissionStatus.ESCROW_LOCKED_CUSTOMS,
            customsReceiptUrl: null,
            customsReceiptSha256: null,
          },
        })
        if (updated.count !== 1) throw new CustomsReviewConflictError()
        await tx.adminAuditLog.create({
          data: { adminId: req.user.sub, action: 'CUSTOMS_REJECT', missionId: id },
        })
      })
    } catch (err) {
      if (err instanceof CustomsReviewConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_REVIEW' })
      }
      throw err
    }
    const rejected = await prisma.mission.findUniqueOrThrow({ where: { id } })
    // Notification voyageur (D5) : quittance refusée → re-soumission attendue.
    // safeEmit POST-COMMIT (hors transaction) : un sink défaillant ne casse jamais
    // la route et n'annule pas la décision déjà committée. travelerId = cible.
    safeEmit(opts.onAlert, {
      code: 'CUSTOMS_RECEIPT_REJECTED',
      message: 'Quittance douanière refusée — voyageur à notifier (nouvelle soumission attendue)',
      details: { missionId: id, travelerId: rejected.travelerId },
    })
    return reply.code(200).send(rejected)
  })

  // POST /api/missions/:id/dropoff-receipt — le VOYAGEUR enregistre le dépôt/la
  // remise du colis (preuve de dépôt + numéro de suivi optionnel). Transition
  // conditionnelle {MATCHED | VALIDATED} → DEPOSITED. Réservé au voyageur assigné
  // (404 masquant pour un tiers, jamais 403 : on ne révèle pas l'existence d'une
  // mission — même invariant IDOR que tout le module, cf. mission-access.ts).
  const DROPOFF_ALLOWED_STATUSES: MissionStatus[] = [
    MissionStatus.MATCHED,
    MissionStatus.VALIDATED,
  ]
  app.post(
    '/:id/dropoff-receipt',
    { schema: { params: missionIdParamsSchema, body: dropoffReceiptBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      // Garde IDOR : 404 si la mission n'existe pas OU si l'appelant n'est pas le
      // voyageur assigné (acheteur/tiers) — les deux cas indistinguables.
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

      // Garde de sécurité financière : un dépôt n'est légitime que depuis un état
      // valide (MATCHED, ou VALIDATED post-douane) — sinon 400 explicite AVANT
      // toute écriture. Bloque un dépôt sur une mission déjà soldée/refundée/etc.
      if (!DROPOFF_ALLOWED_STATUSES.includes(mission.status)) {
        return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
      }

      const { dropoffReceiptUrl, dropoffTrackingNumber } = req.body as DropoffReceiptBody

      // Sceau QR interne IDEMPOTENT : si /ship n'a pas posé de sceau (ex. MATCHED →
      // DEPOSITED direct, sans passer par /ship), on le génère ICI — sinon la collecte
      // resterait sans preuve. Sceau déjà présent → on n'écrase JAMAIS (déjà imprimé).
      // Brut renvoyé une seule fois (impression/scellage), seul le sha256 persisté.
      const newInnerQrCode = mission.innerQrCodeHash ? null : randomBytes(32).toString('hex')

      // Transaction atomique : transition conditionnelle (anti-TOCTOU) + métadonnées
      // de dépôt. dropoffAt = horloge SERVEUR (jamais le device). Tout rollback
      // ensemble si la mission a quitté l'état attendu entre la lecture et l'écriture.
      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: { in: DROPOFF_ALLOWED_STATUSES } },
            data: {
              status: MissionStatus.DEPOSITED,
              dropoffReceiptUrl,
              dropoffTrackingNumber: dropoffTrackingNumber ?? null,
              dropoffAt: new Date(),
              ...(newInnerQrCode ? { innerQrCodeHash: hashQrCode(newInnerQrCode) } : {}),
            },
          })
          if (updated.count !== 1) throw new DropoffConflictError()
        })
      } catch (err) {
        if (err instanceof DropoffConflictError) {
          return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
        }
        throw err
      }

      const deposited = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      // Brut joint à la réponse UNIQUEMENT s'il vient d'être généré ici (jamais re-dérivable).
      return reply
        .code(200)
        .send(newInnerQrCode ? { ...deposited, innerQrCode: newInnerQrCode } : deposited)
    },
  )

  // POST /api/missions/:id/confirm-collection — l'ACHETEUR confirme la collecte du
  // colis déposé (depuis DEPOSITED) et déclenche la libération du séquestre vers le
  // voyageur. AUCUN transfers.create ni écriture ledger ici : on emprunte le chemin
  // financier existant (même contrat que /validate et /customs-approve) —
  //   capture Stripe HORS tx → webhook payment_intent.succeeded journalise
  //   PAYOUT/COMMISSION + crée le TransferOutbox PENDING → transfer-worker (seul
  //   exécutant) exécute transfers.create → mission RELEASED (final).
  // La route pose seulement l'état transitoire VALIDATED ; le webhook finalise.
  // Réservé à l'acheteur (404 masquant pour un tiers/voyageur — invariant IDOR).
  app.post(
    '/:id/confirm-collection',
    // Pas de body schema : le corps est OPTIONNEL (missions sans sceau = corps vide,
    // chemin historique). Un schéma `object` ferait échouer la validation d'un POST
    // sans body (INVALID_INPUT) ; le code brut QR est donc lu et validé à la main.
    { schema: { params: missionIdParamsSchema } },
    async (req, reply) => {
    const { id } = req.params as { id: string }
    // Garde IDOR : 404 si la mission n'existe pas OU si l'appelant n'en est pas
    // l'acheteur (voyageur/tiers) — les deux cas indistinguables.
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

    // Garde d'état : la collecte ne se confirme QUE depuis DEPOSITED (strict).
    if (mission.status !== MissionStatus.DEPOSITED) {
      return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
    }

    // Preuve QR interne (anti « colis vide ») : si un sceau a été enregistré, la
    // collecte EXIGE le code brut scellé dans le colis, vérifié en temps constant.
    // Contrôlé AVANT toute capture Stripe — jamais de libération sur preuve absente
    // ou invalide. Mission sans sceau (innerQrCodeHash null) → chemin historique.
    if (mission.innerQrCodeHash) {
      const raw = (req.body as { innerQrCode?: unknown } | null)?.innerQrCode
      if (
        typeof raw !== 'string' ||
        raw.length === 0 ||
        raw.length > 512 ||
        !qrCodeMatches(raw, mission.innerQrCodeHash)
      ) {
        return reply.code(400).send({ error: 'INVALID_QR_PROOF' })
      }
    }

    // Précondition escrow — lecture HORS transaction (règle d'or). Le séquestre
    // doit être HELD : s'il est déjà RELEASED (webhook passé), 400 sans re-capturer.
    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: mission.id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
    }

    // Capture HORS transaction DB (règle d'or). Clé déterministe propre à ce
    // chemin : un retry après crash re-présente la même clé → un seul débit Stripe.
    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `capture_collection_${mission.id}` },
    )

    // Transaction atomique : SEULE écriture = transition conditionnelle (anti-TOCTOU)
    // DEPOSITED → VALIDATED (transitoire). Aucune écriture comptable ici — le ledger
    // (PAYOUT/COMMISSION) et le TransferOutbox sont portés par le webhook.
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.DEPOSITED },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new CollectionConflictError()
      })
    } catch (err) {
      if (err instanceof CollectionConflictError) {
        return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
      }
      throw err
    }

    const confirmed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(confirmed)
  })

  // POST /api/missions/:id/dispute — l'ACHETEUR ouvre un litige sur un colis déposé
  // (depuis DEPOSITED). GÈLE la mission : DEPOSITED → DISPUTED. Effet de sécurité —
  // DISPUTED n'est ciblé par AUCUN worker de timeout (ni la capture auto §7 collecte,
  // ni le refund auto §6 douane) : plus aucune exécution automatique, arbitrage humain.
  // Réservé à l'acheteur (404 masquant pour un tiers/voyageur — invariant IDOR).
  app.post(
    '/:id/dispute',
    { schema: { params: missionIdParamsSchema, body: disputeBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      // Garde IDOR : 404 si la mission n'existe pas OU si l'appelant n'en est pas
      // l'acheteur (voyageur/tiers) — les deux cas indistinguables.
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

      // Garde d'état : le litige ne s'ouvre QUE depuis DEPOSITED (strict). Déjà
      // VALIDATED/RELEASED (collecte confirmée, fonds en cours de versement) → 400.
      if (mission.status !== MissionStatus.DEPOSITED) {
        return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
      }

      const { disputeReason } = req.body as DisputeBody

      // Transaction atomique : SEULE écriture = transition conditionnelle (anti-TOCTOU)
      // DEPOSITED → DISPUTED + motif + horodatage SERVEUR. Aucun mouvement d'argent.
      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.DEPOSITED },
            data: {
              status: MissionStatus.DISPUTED,
              disputeReason: disputeReason ?? null,
              disputedAt: new Date(),
            },
          })
          if (updated.count !== 1) throw new DisputeConflictError()
        })
      } catch (err) {
        if (err instanceof DisputeConflictError) {
          return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
        }
        throw err
      }

      const disputed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      // Alerte critique POST-COMMIT (hors transaction) : un sink défaillant ne casse
      // jamais la route et n'annule pas le litige déjà committé (convention safeEmit).
      // Bloque toute exécution automatique côté ops : arbitrage humain requis.
      safeEmit(opts.onAlert, {
        code: 'MISSION_DISPUTED_BY_BUYER',
        message: 'Litige ouvert par l\'acheteur sur une mission déposée — fonds gelés, arbitrage humain requis',
        details: { missionId: id, buyerId: mission.buyerId, travelerId: mission.travelerId },
      })
      return reply.code(200).send(disputed)
    },
  )

  // POST /api/missions/:id/admin/resolve-refund — ARBITRAGE ADMIN (§8) d'un litige
  // EN FAVEUR DE L'ACHETEUR : annule le séquestre HELD (jamais capturé) et solde la
  // mission DISPUTED → CANCELLED. Réservé aux comptes isAdmin (403 sinon). L'escrow
  // d'une mission DISPUTED est toujours HELD (litige ouvert depuis DEPOSITED) : on
  // ANNULE le hold (paymentIntents.cancel), on ne rembourse pas une capture
  // inexistante — miroir du timeout douanier (reconciliation.ts §6).
  // Ordre : garde admin → garde état DISPUTED → escrow HELD → cancel Stripe HORS tx
  // (règle d'or, clé admin_refund_<id>) → $transaction(transition + audit atomiques).
  app.post('/:id/admin/resolve-refund', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      return reply.code(403).send({ error: 'FORBIDDEN' })
    }
    const { id } = req.params as { id: string }

    // Garde d'état : l'arbitrage ne s'applique QU'À une mission gelée (DISPUTED).
    // Mission absente ⇒ même 400 (route admin de confiance, pas de masquage IDOR).
    const mission = await prisma.mission.findUnique({ where: { id }, select: { status: true } })
    if (!mission || mission.status !== MissionStatus.DISPUTED) {
      return reply.code(400).send({ error: 'MISSION_NOT_DISPUTED' })
    }

    // Précondition escrow — lecture HORS transaction (règle d'or). HELD requis :
    // un hold déjà RELEASED/CANCELLED ⇒ 400 (pas de double action sur l'argent).
    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
    }
    if (!opts.stripe.paymentIntents.cancel) {
      return reply.code(500).send({ error: 'REFUND_UNAVAILABLE' }) // SDK sans cancel (fake)
    }

    // Annulation HORS transaction DB (règle d'or). Clé déterministe : un retry
    // admin après crash ré-annule le MÊME PI une seule fois côté Stripe.
    await opts.stripe.paymentIntents.cancel(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `admin_refund_${id}` },
    )

    // Transition + audit ATOMIQUES (D-c) : la décision admin et sa trace
    // AdminAuditLog committent ensemble ou pas du tout. Transition conditionnelle
    // (anti-TOCTOU) : un 2e appel voit count 0 (mission déjà CANCELLED) → 400.
    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id, status: MissionStatus.DISPUTED },
          data: { status: MissionStatus.CANCELLED },
        })
        if (updated.count !== 1) throw new ResolveRefundConflictError()
        await tx.adminAuditLog.create({
          data: { adminId: req.user.sub, action: 'ADMIN_RESOLVE_REFUND', missionId: id },
        })
      })
    } catch (err) {
      if (err instanceof ResolveRefundConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_DISPUTED' })
      }
      throw err
    }
    const resolved = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(resolved)
  })

  // POST /api/missions/:id/admin/resolve-payout — ARBITRAGE ADMIN (§8) d'un litige
  // EN FAVEUR DU VOYAGEUR : capture le séquestre HELD et solde la mission
  // DISPUTED → VALIDATED (transitoire). Réservé aux comptes isAdmin (403 sinon).
  // Le webhook payment_intent.succeeded prend le relais (ledger CAPTURE/PAYOUT/
  // COMMISSION + TransferOutbox + RELEASED) — JAMAIS dupliqué ici. Même contrat
  // que /validate, /customs-approve, /confirm-collection : capture HORS tx → webhook.
  app.post('/:id/admin/resolve-payout', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      return reply.code(403).send({ error: 'FORBIDDEN' })
    }
    const { id } = req.params as { id: string }

    const mission = await prisma.mission.findUnique({ where: { id }, select: { status: true } })
    if (!mission || mission.status !== MissionStatus.DISPUTED) {
      return reply.code(400).send({ error: 'MISSION_NOT_DISPUTED' })
    }

    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
    }

    // Capture HORS transaction DB (règle d'or). Clé déterministe propre au chemin
    // arbitrage : un retry admin re-présente la même clé → un seul débit Stripe.
    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `admin_payout_${id}` },
    )

    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id, status: MissionStatus.DISPUTED },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new ResolvePayoutConflictError()
        await tx.adminAuditLog.create({
          data: { adminId: req.user.sub, action: 'ADMIN_RESOLVE_PAYOUT', missionId: id },
        })
      })
    } catch (err) {
      if (err instanceof ResolvePayoutConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_DISPUTED' })
      }
      throw err
    }
    const resolved = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(resolved)
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

    // Hardening voyageur (Sprint 13) : pas de carte de garantie enregistrée ⇒
    // acceptation refusée AVANT toute assignation. Aucun mouvement, mission intacte.
    if (!(await travelerHasGuaranteeCard(userId))) {
      return reply.code(400).send({ error: 'TRAVELER_CARD_MISSING' })
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

    // Hardening voyageur (Sprint 13) : carte de garantie obligatoire pour accepter.
    if (!(await travelerHasGuaranteeCard(userId))) {
      return reply.code(400).send({ error: 'TRAVELER_CARD_MISSING' })
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

      // Sceau QR interne (anti « colis vide ») : à l'entrée du flux transport, on
      // génère un code aléatoire opaque (256 bits) destiné à être IMPRIMÉ ET SCELLÉ
      // À L'INTÉRIEUR du colis. On ne persiste QUE son sha256 ; le code brut est
      // renvoyé UNE SEULE FOIS ici (jamais restocké) pour impression. À la collecte,
      // l'acheteur le scanne et /confirm-collection le vérifie avant libération.
      const innerQrCode = randomBytes(32).toString('hex')
      const innerQrCodeHash = hashQrCode(innerQrCode)

      const updated = await prisma.mission.updateMany({
        where: { id, travelerId: req.user.sub, status: MissionStatus.MATCHED },
        data: {
          status: MissionStatus.IN_PROGRESS,
          trackingReference,
          purchaseAmountCents,
          innerQrCodeHash,
        },
      })
      if (updated.count !== 1) {
        return reply.code(400).send({ error: 'MISSION_NOT_MATCHED' })
      }

      const shipped = await prisma.mission.findUniqueOrThrow({ where: { id } })
      // Code brut joint à la réponse pour impression/scellage — jamais persisté en clair.
      return reply.code(200).send({ ...shipped, innerQrCode })
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

      // Modèle « Drive » (Sprint 16) — pas d'attente synchrone en rayon. L'acheteur
      // pré-autorise (ou non) la substitution dès la commande (mission.substitutionAuthorized) :
      //   • reçu ≤ budget figé           → achat nominal, aucune substitution.
      //   • reçu > budget SANS pré-autorisation → refus (comportement historique inchangé).
      //   • reçu > budget AVEC pré-autorisation → toléré jusqu'à un PLAFOND STRICT de 120%
      //     du budget (centimes Int, jamais Float) ; au-delà → refus. La SubstitutionRequest
      //     est scellée APPROVED dans la MÊME transaction que le reçu (la « validation humaine »
      //     est le consentement acheteur en amont — jamais un auto-accept déclenché en caisse).
      const isSubstitution = purchaseAmountCents > mission.budgetCents
      if (isSubstitution) {
        if (!mission.substitutionAuthorized) {
          return reply.code(400).send({ error: 'RECEIPT_AMOUNT_EXCEEDS_BUDGET' })
        }
        if (purchaseAmountCents > substitutionCeilingCents(mission.budgetCents)) {
          return reply.code(400).send({ error: 'SUBSTITUTION_PRICE_EXCEEDS_LIMIT' })
        }
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
          if (isSubstitution) {
            // Substitution pré-validée par l'acheteur (Drive) → scellée APPROVED dans la
            // même transaction que le reçu (atomicité : reçu + substitution committent ou
            // rollback ensemble). Mission mono-produit → une seule ligne (`lineItemRef: 'MAIN'`) ;
            // le justificatif réel est le reçu scellé (urlRecu). `APPROVED` est la valeur
            // d'enum existante pour « accepté par l'acheteur » (terme métier « ACCEPTED » du
            // workflow substitution) — réutilisée, pas de synonyme ajouté.
            await tx.substitutionRequest.create({
              data: {
                missionId: mission.id,
                lineItemRef: 'MAIN',
                proposedProduct: mission.targetProduct,
                proposedPriceCents: purchaseAmountCents,
                status: SubstitutionStatus.APPROVED,
                resolvedAt: new Date(),
              },
            })
          }
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

  // ── POST /:id/drop-off ────────────────────────────────────────────────────
  // Dépôt logistique asynchrone : le voyageur confie le colis à un réseau tiers
  // (casier, point relais, bureau de poste). Réservé au voyageur assigné (404
  // masquant pour l'acheteur ou un tiers — invariant IDOR). Transition atomique
  // IN_PROGRESS → AWAITING_VALIDATION ; `droppedAt` scellé serveur.
  app.post<{ Params: { id: string }; Body: DropOffBody }>(
    '/:id/drop-off',
    { schema: { body: dropOffBodySchema } },
    async (req, reply) => {
      const { id } = req.params
      const userId = req.user.sub
      const { dropOffType, dropOffCarrier, dropOffTrackingId, dropOffAccessCode } = req.body

      try {
        await prisma.$transaction(async tx => {
          // findMissionForTraveler retourne null si l'appelant est l'acheteur ou
          // un tiers → 404 masquant (invariant IDOR, comme /dropoff-receipt).
          const mission = await findMissionForTraveler(tx, id, userId)
          if (!mission) throw new LogisticsDropOffNotFoundError()

          if (mission.status !== MissionStatus.IN_PROGRESS) {
            throw new LogisticsDropOffStatusError()
          }

          // Transition conditionnelle anti-TOCTOU : si la mission a quitté
          // IN_PROGRESS entre le findUnique et l'update, count === 0 → abort.
          const updated = await tx.mission.updateMany({
            where: { id, status: MissionStatus.IN_PROGRESS },
            data: {
              dropOffType,
              dropOffCarrier,
              dropOffTrackingId,
              dropOffAccessCode,
              droppedAt: new Date(),
              status: MissionStatus.AWAITING_VALIDATION,
            },
          })
          if (updated.count !== 1) throw new LogisticsDropOffConflictError()
        })
      } catch (err) {
        if (err instanceof LogisticsDropOffNotFoundError) {
          return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
        }
        if (err instanceof LogisticsDropOffStatusError || err instanceof LogisticsDropOffConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
        }
        throw err
      }

      const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
      return reply.code(200).send({
        status: mission.status,
        droppedAt: mission.droppedAt,
        dropOffType: mission.dropOffType,
        dropOffCarrier: mission.dropOffCarrier,
        dropOffTrackingId: mission.dropOffTrackingId,
      })
    },
  )

  // ── POST /:id/reviews ─────────────────────────────────────────────────────
  // Notation mutuelle post-clôture. Statuts terminaux acceptés : RELEASED (fin
  // normale) et CANCELLED (fin par arbitrage ou paiement échoué). L'auteur doit
  // être participant (buyer ou traveler) ; targetId est l'autre partie, dérivé
  // automatiquement. Doublon (@@unique missionId+authorId) → 409.
  app.post<{ Params: { id: string }; Body: ReviewBody }>(
    '/:id/reviews',
    { schema: { body: reviewBodySchema } },
    async (req, reply) => {
      const { id } = req.params
      const userId = req.user.sub
      const { rating, comment } = req.body

      let review
      try {
        review = await prisma.$transaction(async tx => {
          // findMissionForParticipant accepte tout objet { mission: { findUnique } } —
          // la transaction interactive `tx` satisfait ce contrat (même API que PrismaClient).
          const access = await findMissionForParticipant(tx, id, userId)
          if (!access) throw new ReviewNotFoundError()

          const { mission, relation } = access
          if (
            mission.status !== MissionStatus.RELEASED &&
            mission.status !== MissionStatus.CANCELLED
          ) {
            throw new ReviewNotTerminalError()
          }

          let targetId: string
          if (relation === 'buyer') {
            if (!mission.travelerId) throw new ReviewNoTravelerError()
            targetId = mission.travelerId
          } else {
            targetId = mission.buyerId
          }

          return tx.review.create({
            data: { missionId: id, authorId: userId, targetId, rating, comment },
          })
        })
      } catch (err) {
        if (err instanceof ReviewNotFoundError) {
          return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
        }
        if (err instanceof ReviewNotTerminalError) {
          return reply.code(400).send({ error: 'MISSION_NOT_TERMINAL' })
        }
        if (err instanceof ReviewNoTravelerError) {
          return reply.code(400).send({ error: 'NO_TRAVELER_ASSIGNED' })
        }
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'REVIEW_ALREADY_SUBMITTED' })
        }
        throw err
      }

      return reply.code(201).send(review)
    },
  )
}

export default missionRoute
