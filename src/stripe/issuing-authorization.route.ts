import { FastifyPluginAsync } from 'fastify'
import Stripe from 'stripe'
import { prisma } from '../db'
import { AuthDecision, EscrowStatus } from '../generated/prisma'
import { AlertSink, safeEmit } from '../alerts'

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
        // Chemin critique : UNE lecture indexée (stripeIssuingCardId @unique).
        const escrow = await prisma.escrowTransaction.findUnique({
          where: { stripeIssuingCardId: cardId },
          select: { missionId: true, status: true, spendingLimitCents: true },
        })
        if (!escrow) {
          reason = 'UNKNOWN_CARD'
        } else {
          missionId = escrow.missionId
          if (escrow.status !== EscrowStatus.HELD) {
            reason = 'ESCROW_NOT_HELD'
          } else if (requestedCents > escrow.spendingLimitCents) {
            // Le cumul multi-autorisations est borné par les Spending Controls
            // posés à l'émission ; ici contrôle unitaire contre le budget mission.
            reason = 'OVER_BUDGET'
          } else {
            approved = true
            reason = 'WITHIN_BUDGET'
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
