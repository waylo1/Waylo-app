import Fastify, { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import Stripe from 'stripe'
import authRoute from './auth/auth.route'
import missionRoute from './missions/routes/index'
import escrowRoute from './escrow/escrow.route'
import arbitrageRoute from './admin/arbitrage.route'
import type { PaymentIntentClient } from './missions/mission-common'
import issuingAuthorizationRoute from './stripe/issuing-authorization.route'
import stripeWebhookRoute from './stripe/webhook.route'
import receiptsRoute from './receipts/receipts.route'
import { readAuthCookie } from './auth/cookie'
import { AlertSink } from './alerts'
import { AppError } from './errors/app.error'
import { registerSlowRequestLogger } from './monitoring/slowRequestLogger'
import debugRoute from './debug/performance.route'
// SSOT : le contrat d'identité du JWT vit dans @waylo/shared (partagé avec le mobile).
// `import type` → effacé au runtime, aucune dépendance ajoutée au backend.
import type { TokenClaims } from '@waylo/shared'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // Payload minimal : identité seule. Aucun rôle de compte (rôles
    // contextuels), aucun kycStatus (relu frais en DB, jamais figé dans un JWT).
    payload: TokenClaims
    user: TokenClaims
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler JWT : 401 { error: 'UNAUTHORIZED' } si token absent/invalide/expiré. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

export interface BuildAppOptions {
  /** Hook d'alertes opérationnelles (cf. src/alerts.ts). Défaut : log structuré stderr. */
  onAlert?: AlertSink
  /** Client Stripe pour le financement T0 — injectable (fake en test). Défaut : SDK réel. */
  stripe?: PaymentIntentClient
}

/**
 * App Waylo. Routes publiques : /health, /api/auth/register, /api/auth/login.
 * /api/stripe/* : authentifié par signature Stripe (constructEvent), JAMAIS
 * par JWT. Tout le reste : preHandler `authenticate` (JWT).
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    throw new Error('JWT_ENV_MISSING') // fail fast, même motif que les secrets Stripe
  }

  // Derrière le proxy Fly : req.ip doit refléter le client réel (X-Forwarded-For)
  // pour que le rate-limit par IP (rate-limit.ts) soit effectif.
  const app = Fastify({ logger: true, trustProxy: true })

  // Observabilité : logue (warn) toute requête dépassant 100 ms (hrtime ns).
  // Posé tôt : les hooks racine couvrent toutes les routes enregistrées ensuite.
  registerSlowRequestLogger(app)

  // Gestionnaire d'erreurs CENTRAL (cf. src/errors/app.error.ts). Portée : contexte
  // racine — fallback de TOUTE route sans handler propre. Les routes qui posent leur
  // propre setErrorHandler (auth, missions, escrow, receipts) gardent la main dans
  // leur encapsulation Fastify ; les routes Stripe traitent tout en interne (aucun
  // throw sortant). Trois branches, mutuellement exclusives :
  //   1. AppError → statut porté + { error: code, details? } (échec métier maîtrisé) ;
  //   2. validation Ajv (err.validation) → 400 INVALID_INPUT (fail-closed) ;
  //   3. reste (bug, panne) → log.error + 500 INTERNAL_SERVER_ERROR (aucune fuite).
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error instanceof AppError) {
      const body =
        error.details === undefined
          ? { error: error.code }
          : { error: error.code, details: error.details }
      return reply.status(error.statusCode).send(body)
    }
    if (error.validation) {
      return reply.status(400).send({ error: 'INVALID_INPUT' })
    }
    req.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({ error: 'INTERNAL_SERVER_ERROR' })
  })

  await app.register(fastifyJwt, { secret: jwtSecret })

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // Authorization: Bearer prioritaire (clients/tests) ; à défaut, le jeton
      // du cookie HttpOnly est injecté en en-tête pour réutiliser jwtVerify
      // (vérification + typage de req.user identiques aux deux chemins).
      const header = req.headers.authorization
      if (!(typeof header === 'string' && header.startsWith('Bearer '))) {
        const token = readAuthCookie(req.headers.cookie)
        if (token) req.headers.authorization = `Bearer ${token}`
      }
      await req.jwtVerify()
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED' })
    }
  })

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

  let paymentClient = options.stripe
  if (!paymentClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY
    if (!secretKey) throw new Error('STRIPE_ENV_MISSING') // même fail-fast que les plugins webhook
    paymentClient = new Stripe(secretKey)
  }

  await app.register(authRoute, { prefix: '/api/auth' })
  await app.register(missionRoute, {
    prefix: '/api/missions',
    stripe: paymentClient,
    onAlert: options.onAlert,
  })
  await app.register(escrowRoute, {
    prefix: '/api/escrow',
    stripe: paymentClient,
    onAlert: options.onAlert,
  })
  // Upload de reçu (S21) : multipart → outbox d'extraction OCR (worker async).
  // Aucun client Stripe — la route ne fait que valider + mettre en file.
  await app.register(receiptsRoute, { prefix: '/api/receipts' })
  // Arbitrage admin de fraude voyageur (Sprint 14) — aucun client Stripe (journalise
  // l'intention de ponction + le ledger ; l'exécution monétaire relève d'un worker).
  await app.register(arbitrageRoute, { prefix: '/api/admin' })
  // Diagnostic de performance (admin) : GET /debug/performance — lecture seule
  // (pool Prisma, timing workers, mémoire). Guard JWT + isAdmin, comme /api/admin/*.
  await app.register(debugRoute, { prefix: '/debug' })

  // Les plugins Stripe portent chacun leur parser raw application/json
  // (encapsulé) : constructEvent exige les octets exacts du body, sans
  // impacter le parsing JSON du reste de l'app.
  await app.register(issuingAuthorizationRoute, {
    prefix: '/api/stripe',
    onAlert: options.onAlert,
  })
  await app.register(stripeWebhookRoute, { prefix: '/api/stripe', onAlert: options.onAlert })

  return app
}
