import { FastifyPluginAsync } from 'fastify'
import Stripe from 'stripe'
import { prisma } from '../db'
import { AuthDecision } from '../generated/prisma'
import { AlertSink, safeEmit } from '../alerts'
import {
  decideJitAuthorization,
  parseAuthorizationEvent,
  toWebhookReply,
  type JitAuthorizationDecision,
  type JitDecisionInput,
} from '../services/stripe/jit-handler.service'

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
 * se réduit donc à : vérif signature + UNE lecture indexée + délégation au
 * cœur pur (`jit-handler.service.ts`). Aucun appel réseau sortant, aucune
 * agrégation, aucun write bloquant.
 *
 * La décision (gardes, plafond 120%, hard cap 150%) vit dans le service pur,
 * testée hors DB par `scripts/jit-proof.mts`. Cette route reste la coquille
 * I/O : signature, lecture indexée escrow, audit fire-and-forget.
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

    const facts = parseAuthorizationEvent(event)

    let decision: JitAuthorizationDecision
    let missionId: string | null = null

    try {
      // Chemin critique : UNE lecture indexée (stripeIssuingCardId @unique) +
      // jointure mission sur sa PK (statut de gel) — toujours un seul aller-retour.
      const escrow = await prisma.escrowTransaction.findUnique({
        where: { stripeIssuingCardId: facts.cardId },
        select: {
          missionId: true,
          status: true,
          spendingLimitCents: true,
          mission: { select: { status: true, substitutionAuthorized: true, budgetCents: true } },
        },
      })
      missionId = escrow?.missionId ?? null

      const input: JitDecisionInput = {
        requestedAmountCents: facts.requestedAmountCents,
        escrow: escrow ? { status: escrow.status, spendingLimitCents: escrow.spendingLimitCents } : null,
        mission: escrow ? escrow.mission : null,
      }
      decision = decideJitAuthorization(input)
    } catch (err) {
      // Erreur DB = doute = refus. On ne bloque jamais la réponse sur un retry.
      decision = { approved: false, reason: 'UNKNOWN_CARD', declineCode: 'card_inactive' }
      req.log.error({ err, cardId: facts.cardId }, 'issuing JIT lookup failed')
      // Refus fail-safe mais signal opérationnel : en rafale, c'est un runner
      // bloqué en caisse pour une panne infra — pas un simple log.
      safeEmit(opts.onAlert, {
        code: 'ISSUING_JIT_LOOKUP_ERROR',
        message: 'Autorisation JIT refusée sur erreur de lookup DB (refus par défaut)',
        details: { cardId: facts.cardId, authorizationId: facts.authorizationId, err: String(err) },
      })
    }

    // Audit KYC/AML — non bloquant : la réponse part sans attendre ce write.
    // @unique sur stripeAuthorizationId absorbe les retries Stripe (P2002 ignoré).
    void prisma.issuingAuthorizationLog
      .create({
        data: {
          missionId,
          stripeAuthorizationId: facts.authorizationId,
          requestedAmountCents: facts.requestedAmountCents ?? 0,
          decision: decision.approved ? AuthDecision.APPROVED : AuthDecision.DECLINED,
          reason: decision.reason,
        },
      })
      .catch(err => {
        if (err?.code !== 'P2002') {
          req.log.error({ err, authorizationId: facts.authorizationId }, 'issuing audit log failed')
        }
      })

    return reply.code(200).send(toWebhookReply(decision))
  })
}

export default issuingAuthorizationRoute
