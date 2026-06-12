import { FastifyPluginAsync } from 'fastify'
import Stripe from 'stripe'
import { prisma } from '../db'
import {
  AuthDecision,
  EscrowStatus,
  KycStatus,
  LedgerType,
  MissionStatus,
  Prisma,
  SubstitutionStatus,
} from '../generated/prisma'
import { AlertSink, OpsAlertInput, safeEmit } from '../alerts'

type Tx = Prisma.TransactionClient

/**
 * Abort DÉLIBÉRÉ d'un effet métier : l'alerte (WEBHOOK_ABORT_NON_RECOVERABLE)
 * a déjà été émise AVANT le throw. Le catch de la route ne ré-alerte pas ces
 * erreurs — seules les erreurs inattendues émettent WEBHOOK_PROCESSING_FAILED.
 */
class WebhookAbortError extends Error {}

/** Émetteur d'alerte immédiat (la sévérité est dérivée du code par safeEmit). */
type AlertEmitter = (input: OpsAlertInput) => void

/** Résultat d'un effet métier : alertes différées émises APRÈS commit uniquement. */
interface EffectOutcome {
  handled: boolean
  deferredAlerts: OpsAlertInput[]
}

export interface StripeWebhookOptions {
  /** Hook d'alerte (pager, Slack…) — cf. src/alerts.ts. */
  onAlert?: AlertSink
}

/**
 * POST /api/stripe/webhook — événements asynchrones.
 *
 * Idempotence : ProcessedStripeEvent et l'effet métier sont écrits dans la MÊME
 * prisma.$transaction — soit les deux committent, soit rien. Un event rejoué
 * trouve sa ligne et ressort en 200 sans effet. Deux livraisons concurrentes :
 * l'une commit, l'autre casse sur le @unique stripeEventId → rollback → 500 →
 * retry Stripe → détecté en doublon → 200.
 *
 * 200 uniquement après commit. Un throw n'arrive QUE depuis la transaction
 * (rollback total) : on ne renvoie jamais 500 après un write committé.
 *
 * Alertes (cf. src/alerts.ts) :
 * - abort non auto-réparable → alerte émise AVANT le throw (la visibilité
 *   survit au rollback ; elle se répète à chaque rejeu Stripe — c'est voulu,
 *   le signal persiste tant que la condition n'est pas corrigée) ;
 * - chemin nominal (ex. TRAVELER_ACCOUNT_MISSING) → alerte différée post-commit.
 */
const stripeWebhookRoute: FastifyPluginAsync<StripeWebhookOptions> = async (app, opts) => {
  // constructEvent exige les octets EXACTS du body : parser raw SCOPÉ à ce
  // plugin (encapsulation Fastify) — le reste de l'app garde le JSON parsé.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  )

  const secretKey = process.env.STRIPE_SECRET_KEY
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secretKey || !webhookSecret) {
    throw new Error('STRIPE_ENV_MISSING')
  }
  const stripe = new Stripe(secretKey)

  app.post('/webhook', async (req, reply) => {
    const signature = req.headers['stripe-signature']
    if (typeof signature !== 'string') {
      return reply.code(400).send({ error: 'MISSING_SIGNATURE' })
    }

    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret)
    } catch {
      return reply.code(400).send({ error: 'INVALID_SIGNATURE' })
    }

    // Émis immédiatement, AVANT un throw : la visibilité survit au rollback.
    const abortAlert: AlertEmitter = input => safeEmit(opts.onAlert, input)

    let outcome: { duplicate: boolean } & EffectOutcome
    try {
      outcome = await prisma.$transaction(async tx => {
        const seen = await tx.processedStripeEvent.findUnique({
          where: { stripeEventId: event.id },
          select: { id: true },
        })
        if (seen) return { duplicate: true, handled: false, deferredAlerts: [] }

        await tx.processedStripeEvent.create({
          data: { stripeEventId: event.id, type: event.type },
        })
        const effect = await applyBusinessEffect(tx, event, abortAlert)
        return { duplicate: false, ...effect }
      })
    } catch (err) {
      // Rollback intégral : rien n'est committé, le 500 est sûr — Stripe rejouera.
      req.log.error({ err, eventId: event.id, type: event.type }, 'webhook processing failed')
      if (!(err instanceof WebhookAbortError)) {
        // Erreur INATTENDUE (DB indisponible, bug) : sans ce signal, Stripe
        // rejoue en silence 3 jours puis désactive l'endpoint. Les aborts
        // délibérés, eux, ont déjà émis leur alerte avant le throw.
        safeEmit(opts.onAlert, {
          code: 'WEBHOOK_PROCESSING_FAILED',
          message: 'Échec inattendu du traitement webhook (rollback intégral, Stripe rejouera)',
          details: { eventId: event.id, type: event.type, err: String(err) },
        })
      }
      return reply.code(500).send({ error: 'WEBHOOK_PROCESSING_FAILED' })
    }

    // Post-commit : alertes du chemin nominal. safeEmit garantit qu'aucun sink
    // défaillant ne produit un 500 après commit.
    for (const alert of outcome.deferredAlerts) safeEmit(opts.onAlert, alert)

    return reply
      .code(200)
      .send({ received: true, duplicate: outcome.duplicate, handled: outcome.handled })
  })
}

const NO_EFFECT: EffectOutcome = { handled: false, deferredAlerts: [] }

/** Route l'event vers son effet métier. NO_EFFECT pour un event hors périmètre (acquitté). */
async function applyBusinessEffect(
  tx: Tx,
  event: Stripe.Event,
  abortAlert: AlertEmitter,
): Promise<EffectOutcome> {
  switch (event.type) {
    case 'payment_intent.succeeded':
      return handleCapture(tx, event.data.object as Stripe.PaymentIntent, abortAlert)
    case 'charge.refunded':
      return applyRefund(tx, event.data.object as Stripe.Charge, abortAlert)
    case 'issuing_authorization.created':
      return backfillIssuingLog(tx, event.data.object as Stripe.Issuing.Authorization)
    default:
      return NO_EFFECT
  }
}

/**
 * payment_intent.succeeded = LA capture réelle (capture différée déclenchée
 * après validation humaine, HORS transaction DB). L'argent est pris côté
 * Stripe QUE CETTE TRANSACTION COMMIT OU NON — d'où l'ordre strict :
 *
 * ÉTAPE 1 — journaliser la capture (CAPTURE + capturedAmountCents), sans
 *   AUCUNE précondition de versement. Transition conditionnelle
 *   capturedAmountCents 0 → montant : une seule journalisation par escrow.
 * ÉTAPE 2 — précondition compte Connect du voyageur. Échec ≠ rollback :
 *   mission routée AWAITING_TRAVELER_ACCOUNT + alerte TRAVELER_ACCOUNT_MISSING
 *   (différée post-commit), réponse 200 — l'argent capturé sans destination
 *   est VISIBLE, pas bloqué dans une boucle de rejeu de 3 jours.
 *   La reprise de la libération est une action explicite (ops/API), pas un
 *   rejeu webhook.
 * ÉTAPE 3 — libération : RELEASED + PAYOUT + COMMISSION + TransferOutbox
 *   (aucun appel Stripe : le worker est le seul exécutant des versements).
 */
async function handleCapture(
  tx: Tx,
  intent: Stripe.PaymentIntent,
  abortAlert: AlertEmitter,
): Promise<EffectOutcome> {
  const escrow = await tx.escrowTransaction.findUnique({
    where: { stripePaymentIntentId: intent.id },
    select: {
      id: true,
      missionId: true,
      status: true,
      capturedAmountCents: true,
      mission: {
        select: {
          commissionCents: true,
          traveler: { select: { stripeAccountId: true, kycStatus: true } },
        },
      },
    },
  })
  if (!escrow) return NO_EFFECT // PaymentIntent étranger à Waylo — acquitté sans effet

  const capturedCents = intent.amount_received
  if (capturedCents <= 0) {
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'payment_intent.succeeded sans montant capturé',
      details: { cause: 'EMPTY_CAPTURE', intentId: intent.id, escrowId: escrow.id },
    })
    throw new WebhookAbortError('EMPTY_CAPTURE')
  }

  // ÉTAPE 1 — capture journalisée en premier, inconditionnellement.
  const captured = await tx.escrowTransaction.updateMany({
    where: { id: escrow.id, status: EscrowStatus.HELD, capturedAmountCents: 0 },
    data: { capturedAmountCents: capturedCents },
  })
  if (captured.count !== 1) {
    if (escrow.capturedAmountCents === capturedCents) {
      // Même capture déjà journalisée sous un autre event.id — acquit idempotent.
      return NO_EFFECT
    }
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'État escrow incompatible avec une capture',
      details: {
        cause: 'CAPTURE_STATE_CONFLICT',
        escrowId: escrow.id,
        escrowStatus: escrow.status,
        alreadyCapturedCents: escrow.capturedAmountCents,
        incomingCapturedCents: capturedCents,
      },
    })
    throw new WebhookAbortError('CAPTURE_STATE_CONFLICT')
  }
  await tx.ledgerEntry.create({
    data: { escrowId: escrow.id, type: LedgerType.CAPTURE, amountCents: capturedCents },
  })

  // ÉTAPE 2 — précondition de versement, APRÈS la capture journalisée.
  const traveler = escrow.mission.traveler
  const destinationAccountId =
    traveler && traveler.kycStatus === KycStatus.VERIFIED ? traveler.stripeAccountId : null
  if (!destinationAccountId) {
    await tx.mission.updateMany({
      where: { id: escrow.missionId },
      data: { status: MissionStatus.AWAITING_TRAVELER_ACCOUNT },
    })
    return {
      handled: true,
      deferredAlerts: [
        {
          code: 'TRAVELER_ACCOUNT_MISSING',
          message:
            'Capture journalisée mais versement impossible : compte Connect absent ou non vérifié — intervention requise',
          details: {
            escrowId: escrow.id,
            missionId: escrow.missionId,
            capturedCents,
            reason: !traveler
              ? 'NO_TRAVELER'
              : traveler.kycStatus !== KycStatus.VERIFIED
                ? 'KYC_NOT_VERIFIED'
                : 'NO_CONNECT_ACCOUNT',
          },
        },
      ],
    }
  }

  // ÉTAPE 3 — libération. Anti-TOCTOU : transition conditionnelle atomique.
  const released = await tx.escrowTransaction.updateMany({
    where: { id: escrow.id, status: EscrowStatus.HELD },
    data: { status: EscrowStatus.RELEASED },
  })
  if (released.count !== 1) {
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'Escrow sorti de HELD pendant la libération',
      details: { cause: 'ESCROW_NOT_HELD', escrowId: escrow.id },
    })
    throw new WebhookAbortError('ESCROW_NOT_HELD')
  }

  const commissionCents = escrow.mission.commissionCents
  const payoutCents = capturedCents - commissionCents
  if (payoutCents < 0) {
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'Commission supérieure au montant capturé',
      details: { cause: 'NEGATIVE_PAYOUT', escrowId: escrow.id, capturedCents, commissionCents },
    })
    throw new WebhookAbortError('NEGATIVE_PAYOUT')
  }

  await tx.ledgerEntry.createMany({
    data: [
      { escrowId: escrow.id, type: LedgerType.PAYOUT, amountCents: payoutCents },
      { escrowId: escrow.id, type: LedgerType.COMMISSION, amountCents: commissionCents },
    ],
  })

  // Intention de versement, committée avec le PAYOUT. idempotencyKey dérivée
  // de l'escrowId (+ @unique) : un seul transfert de libération par escrow.
  await tx.transferOutbox.create({
    data: {
      escrowId: escrow.id,
      destinationAccountId,
      amountCents: payoutCents,
      idempotencyKey: `transfer_release_${escrow.id}`,
    },
  })

  await tx.mission.updateMany({
    where: { id: escrow.missionId, status: MissionStatus.AWAITING_VALIDATION },
    data: { status: MissionStatus.RELEASED },
  })
  return { handled: true, deferredAlerts: [] }
}

/**
 * Remboursement (total ou ligne ignorée après SubstitutionRequest ITEM_SKIPPED).
 * charge.amount_refunded est un CUMUL : on ne journalise que le delta vs le
 * ledger pour rester idempotent même si Stripe agrège plusieurs refunds dans
 * un seul event.
 *
 * Timeline (cf. reconciliation.ts) : un charge.refunded Stripe exige une charge
 * CAPTURÉE — un refund sur un escrow jamais capturé est structurellement
 * impossible et abort avec alerte. Grâce à la capture journalisée à T2,
 * Σ(REFUND) ≤ capturedAmountCents est un vrai garde-fou (jamais comparé à 0).
 *
 * Deux protections distinctes :
 * - idempotence event.id (ProcessedStripeEvent) → rejeu du MÊME event ;
 * - verrou de ligne FOR UPDATE → deux events refund DIFFÉRENTS sur le même
 *   escrow, qui passent tous deux la barrière d'idempotence. Sans verrou,
 *   les deux transactions liraient le même Σ(REFUND) et sur-rembourseraient.
 */
async function applyRefund(
  tx: Tx,
  charge: Stripe.Charge,
  abortAlert: AlertEmitter,
): Promise<EffectOutcome> {
  const intentId =
    typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
  if (!intentId) return NO_EFFECT

  const escrow = await tx.escrowTransaction.findUnique({
    where: { stripePaymentIntentId: intentId },
    select: { id: true, capturedAmountCents: true },
  })
  if (!escrow) return NO_EFFECT

  if (escrow.capturedAmountCents <= 0) {
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'charge.refunded reçu pour un escrow jamais capturé',
      details: { cause: 'REFUND_BEFORE_CAPTURE', escrowId: escrow.id, chargeId: charge.id },
    })
    throw new WebhookAbortError('REFUND_BEFORE_CAPTURE')
  }

  // Anti-TOCTOU : verrou de ligne AVANT toute lecture du ledger, dans la même
  // transaction (Prisma n'a pas de FOR UPDATE natif → raw SQL). La transaction
  // concurrente bloque ici jusqu'au commit, puis relit le Σ(REFUND) à jour.
  await tx.$queryRaw`SELECT id FROM "EscrowTransaction" WHERE id = ${escrow.id} FOR UPDATE`

  const alreadyRefunded = await tx.ledgerEntry.aggregate({
    where: { escrowId: escrow.id, type: LedgerType.REFUND },
    _sum: { amountCents: true },
  })
  const refundedSoFarCents = alreadyRefunded._sum.amountCents ?? 0
  const deltaCents = charge.amount_refunded - refundedSoFarCents
  if (deltaCents === 0) return NO_EFFECT // cumul déjà journalisé — rien de nouveau
  if (deltaCents < 0) {
    // Ledger au-delà du cumul Stripe : corruption comptable — abort (rollback,
    // l'event n'est pas marqué processé). L'alerte part avant le throw.
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'Σ(REFUND) au ledger dépasse le cumul remboursé Stripe',
      details: {
        cause: 'REFUND_LEDGER_AHEAD_OF_STRIPE',
        escrowId: escrow.id,
        ledgerRefundedCents: refundedSoFarCents,
        stripeRefundedCents: charge.amount_refunded,
      },
    })
    throw new WebhookAbortError('REFUND_LEDGER_AHEAD_OF_STRIPE')
  }
  if (refundedSoFarCents + deltaCents > escrow.capturedAmountCents) {
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'Remboursement au-delà du montant capturé',
      details: {
        cause: 'OVER_REFUND',
        escrowId: escrow.id,
        capturedAmountCents: escrow.capturedAmountCents,
        attemptedTotalCents: refundedSoFarCents + deltaCents,
      },
    })
    throw new WebhookAbortError('OVER_REFUND') // jamais rembourser plus que capturé
  }

  const fullRefund = charge.amount_refunded >= escrow.capturedAmountCents
  const updated = await tx.escrowTransaction.updateMany({
    where: {
      id: escrow.id,
      status: { in: [EscrowStatus.HELD, EscrowStatus.PARTIALLY_REFUNDED] },
    },
    data: { status: fullRefund ? EscrowStatus.REFUNDED : EscrowStatus.PARTIALLY_REFUNDED },
  })
  if (updated.count !== 1) {
    abortAlert({
      code: 'WEBHOOK_ABORT_NON_RECOVERABLE',
      message: 'Refund sur un escrow déjà sorti du périmètre remboursable',
      details: { cause: 'ESCROW_REFUND_CONFLICT', escrowId: escrow.id },
    })
    throw new WebhookAbortError('ESCROW_REFUND_CONFLICT')
  }

  await tx.ledgerEntry.create({
    data: { escrowId: escrow.id, type: LedgerType.REFUND, amountCents: deltaCents },
  })

  // Refund initié par un skip de ligne : résoudre la SubstitutionRequest liée
  // (metadata posée par nos soins à la création du refund). Conditionnel
  // PENDING → ITEM_SKIPPED, jamais d'écrasement d'une résolution existante.
  const substitutionRequestId = charge.metadata['substitutionRequestId']
  if (substitutionRequestId) {
    await tx.substitutionRequest.updateMany({
      where: { id: substitutionRequestId, status: SubstitutionStatus.PENDING },
      data: { status: SubstitutionStatus.ITEM_SKIPPED, resolvedAt: new Date() },
    })
  }
  return { handled: true, deferredAlerts: [] }
}

/**
 * Backstop d'audit : le log JIT est écrit en non-bloquant par le endpoint
 * temps réel ; si ce write a échoué, l'event async le rattrape. upsert avec
 * update vide = jamais de mutation d'un log existant (append-only).
 */
async function backfillIssuingLog(
  tx: Tx,
  auth: Stripe.Issuing.Authorization,
): Promise<EffectOutcome> {
  await tx.issuingAuthorizationLog.upsert({
    where: { stripeAuthorizationId: auth.id },
    update: {},
    create: {
      stripeAuthorizationId: auth.id,
      requestedAmountCents: auth.amount,
      decision: auth.approved ? AuthDecision.APPROVED : AuthDecision.DECLINED,
      reason: 'BACKFILL_FROM_ASYNC_EVENT',
    },
  })
  return { handled: true, deferredAlerts: [] }
}

export default stripeWebhookRoute
