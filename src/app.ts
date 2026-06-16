import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import Stripe from 'stripe'
import authRoute from './auth/auth.route'
import missionRoute from './missions/mission.route'
import escrowRoute from './escrow/escrow.route'
import type { PaymentIntentClient } from './missions/mission.route'
import issuingAuthorizationRoute from './stripe/issuing-authorization.route'
import stripeWebhookRoute from './stripe/webhook.route'
import { readAuthCookie } from './auth/cookie'
import { AlertSink } from './alerts'

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // Payload minimal : identité seule. Aucun rôle de compte (rôles
    // contextuels), aucun kycStatus (relu frais en DB, jamais figé dans un JWT).
    payload: { sub: string }
    user: { sub: string }
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

  const app = Fastify({ logger: true })

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
  await app.register(escrowRoute, { prefix: '/api/escrow', stripe: paymentClient })

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
