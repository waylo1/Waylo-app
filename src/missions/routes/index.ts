import { FastifyError, FastifyPluginAsync } from 'fastify'
import { MissionRouteOptions } from '../mission-common'
import { crudRoutes } from './crud.route'
import { fundingRoutes } from './funding.route'
import { validationRoutes } from './validation.route'
import { logisticsRoutes } from './logistics.route'
import { adminRoutes } from './admin.route'
import { walletRoutes } from './wallet/wallet.route'
import { disputeRoutes } from './dispute/dispute.route'

const missionRoute: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: 'INVALID_INPUT' })
    req.log.error({ err }, 'mission route error')
    return reply.code(500).send({ error: 'INTERNAL_ERROR' })
  })

  app.addHook('onRequest', app.authenticate)

  // Mount domain-specific sub-routers
  await app.register(crudRoutes)
  await app.register(fundingRoutes, { stripe: opts.stripe })
  await app.register(validationRoutes, { stripe: opts.stripe })
  await app.register(logisticsRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
  await app.register(adminRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
  await app.register(walletRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
  await app.register(disputeRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
}

export default missionRoute
