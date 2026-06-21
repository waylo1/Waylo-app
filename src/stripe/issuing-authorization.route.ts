import { FastifyPluginAsync } from 'fastify'
import Stripe from 'stripe'
import { prisma } from '../db'
import { AuthDecision, EscrowStatus, MissionStatus } from '../generated/prisma'
import { AlertSink, safeEmit } from '../alerts'
import { substitutionHardCapCents } from '../missions/mission-common'

export interface IssuingAuthorizationOptions {
  /** Hook d'alerte (cf. src/alerts.ts). */
  onAlert?: AlertSink
}

/**
 * POST /api/stripe/issuing-authorization — autorisation JIT temps réel.
 *
 * Contrat Stripe : répondre en < 2 s avec { approved: boolean }, sinon Stripe
 * applique le comportement par défaut. La latence réseau magasin est déjà
 * consommée avant d'atteindre ce serveur (cf. gotchas.md) — le chemin critique
 * se réduit donc à : vérif signature + UNE lecture indexée + comparaison.
 * Aucun appel réseau sortant, aucune agrégation, aucun write bloquant.
 *
 * Défaut = REFUS : doute, erreur, carte inconnue, escrow non HELD → approved: false.
 * Le plafond (Spending Controls = budget mission) est posé UNE SEULE FOIS à
 * l'émission de la carte. Interdit ici : toute mutation de la carte (limite à
 * 0 €, destruction) post-autorisation — cf. gotchas.md.
 */
const issuingAuthorizationRoute: FastifyPluginAsync<IssuingAuthorizationOptions> = async (
  app,
  opts,
) => {
  // constructEvent exige les octets EXACTS du body : parser raw SCOPÉ à ce
  // plugin (encapsulation Fastify) — le reste de l'app garde le JSON parsé.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  )

  const secretKey = process.env.STRIPE_SECRET_KEY
  const issuingWebhookSecret = process.env.STRIPE_ISSUING_WEBHOOK_SECRET
  if (!secretKey || !issuingWebhookSecret) {
    throw new Error('STRIPE_ENV_MISSING') // fail fast — secret dédié, distinct du webhook async
  }
  const stripe = new Stripe(secretKey)

  app.post('/issuing-authorization', async (req, reply) => {
    const signature = req.headers['stripe-signature']
    if (typeof signature !== 'string') {
      return reply.code(400).send({ approved: false, error: 'MISSING_SIGNATURE' })
    }

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, signature, issuingWebhookSecret)
    } catch {
      return reply.code(400).send({ approved: false, error: 'INVALID_SIGNATURE' })
    }

    if (event.type !== 'issuing_authorization.request') {
      return reply.code(200).send({ received: true })
    }

    const authorization = event.data.object as Stripe.Issuing.Authorization
    const requestedCents = authorization.pending_request?.amount ?? null
    const cardId = authorization.card.id

    let approved = false
    let reason = 'DEFAULT_DECLINE'
    let missionId: string | null = null

    try {
      if (requestedCents === null || requestedCents <= 0) {
        reason = 'NO_PENDING_AMOUNT'
      } else {
        // Chemin critique : UNE lecture indexée (stripeIssuingCardId @unique) +
        // jointure mission sur sa PK (statut de gel) — toujours un seul aller-retour.
        const escrow = await prisma.escrowTransaction.findUnique({
          where: { stripeIssuingCardId: cardId },
          select: {
            missionId: true,
            status: true,
            spendingLimitCents: true,
            mission: { select: { status: true, substitutionAuthorized: true, budgetCents: true } },
          },
        })
        if (!escrow) {
          reason = 'UNKNOWN_CARD'
        } else {
          missionId = escrow.missionId
          // Gel des fonds (Sprints 7-8) : une mission DISPUTED garde son escrow
          // HELD, et une mission CANCELLED peut conserver un hold non encore
          // finalisé — dans les deux cas l'achat doit être BLOQUÉ ici, AVANT le
          // contrôle de budget, sinon la carte resterait utilisable sur une
          // mission gelée (l'escrow HELD passerait le test ESCROW_NOT_HELD).
          if (escrow.mission.status === MissionStatus.DISPUTED) {
            reason = 'MISSION_DISPUTED'
          } else if (escrow.mission.status === MissionStatus.CANCELLED) {
            reason = 'MISSION_CANCELLED'
          } else if (escrow.status !== EscrowStatus.HELD) {
            reason = 'ESCROW_NOT_HELD'
          } else {
            // Plafond unitaire. Modèle « Drive » (S17) : si l'acheteur a pré-autorisé
            // la substitution, on autorise jusqu'à 120% du budget (Math.floor, centimes
            // Int) — cohérent avec le séquestre + le Spending Control dimensionnés à 120%
            // au financement. Sinon, plafond figé de l'escrow (= budget). Le cumul
            // multi-autorisations reste borné par les Spending Controls posés à l'émission.
            const ceilingCents = escrow.mission.substitutionAuthorized
              ? Math.floor((escrow.mission.budgetCents * 12) / 10)
              : escrow.spendingLimitCents
            // BACKSTOP 150% (audit robustesse) : borne dure indépendante du plafond
            // opérationnel — aucune autorisation au-delà de 150% du budget, même si
            // le calcul du plafond régressait. Refus fail-safe, motif explicite.
            if (requestedCents > substitutionHardCapCents(escrow.mission.budgetCents)) {
              reason = 'HARD_CAP_EXCEEDED'
            } else if (requestedCents > ceilingCents) {
              reason = 'OVER_BUDGET'
            } else {
              approved = true
              reason = 'WITHIN_BUDGET'
            }
          }
        }
      }
    } catch (err) {
      // Erreur DB = doute = refus. On ne bloque jamais la réponse sur un retry.
      approved = false
      reason = 'LOOKUP_ERROR'
      req.log.error({ err, cardId }, 'issuing JIT lookup failed')
      // Refus fail-safe mais signal opérationnel : en rafale, c'est un runner
      // bloqué en caisse pour une panne infra — pas un simple log.
      safeEmit(opts.onAlert, {
        code: 'ISSUING_JIT_LOOKUP_ERROR',
        message: 'Autorisation JIT refusée sur erreur de lookup DB (refus par défaut)',
        details: { cardId, authorizationId: authorization.id, err: String(err) },
      })
    }

    // Audit KYC/AML — non bloquant : la réponse part sans attendre ce write.
    // @unique sur stripeAuthorizationId absorbe les retries Stripe (P2002 ignoré).
    void prisma.issuingAuthorizationLog
      .create({
        data: {
          missionId,
          stripeAuthorizationId: authorization.id,
          requestedAmountCents: requestedCents ?? 0,
          decision: approved ? AuthDecision.APPROVED : AuthDecision.DECLINED,
          reason,
        },
      })
      .catch(err => {
        if (err?.code !== 'P2002') {
          req.log.error({ err, authorizationId: authorization.id }, 'issuing audit log failed')
        }
      })

    return reply.code(200).send({ approved })
  })
}

export default issuingAuthorizationRoute
