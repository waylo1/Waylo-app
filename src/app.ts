import Fastify, { FastifyInstance } from 'fastify'
import issuingAuthorizationRoute from './stripe/issuing-authorization.route'
import stripeWebhookRoute from './stripe/webhook.route'
import { AlertSink } from './alerts'

export interface BuildAppOptions {
  /** Hook d'alertes opérationnelles (cf. src/alerts.ts). Défaut : log structuré stderr. */
  onAlert?: AlertSink
}

/** App Waylo — webhooks Stripe uniquement. Utilisée par le serveur (listen) et les tests (inject). */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })

  // constructEvent exige les octets EXACTS du body : parser raw global —
  // cette app n'expose que des webhooks Stripe, aucun autre consommateur JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  )

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }))

  await app.register(issuingAuthorizationRoute, {
    prefix: '/api/stripe',
    onAlert: options.onAlert,
  })
  await app.register(stripeWebhookRoute, { prefix: '/api/stripe', onAlert: options.onAlert })

  return app
}
