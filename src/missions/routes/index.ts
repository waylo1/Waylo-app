import { FastifyPluginAsync } from 'fastify'
import { MissionRouteOptions } from '../mission-common'
import { crudRoutes } from './crud.route'
import { fundingRoutes } from './funding.route'
import { validationRoutes } from './validation.route'
import { logisticsRoutes } from './logistics.route'
import { adminRoutes } from './admin.route'
import { walletRoutes } from './wallet/wallet.route'
import { disputeRoutes } from './dispute/dispute.route'
import { assignRoutes } from './assign.route'

const missionRoute: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  app.addHook('onRequest', app.authenticate)

  // Mount domain-specific sub-routers
  await app.register(crudRoutes)
  await app.register(assignRoutes)
  await app.register(fundingRoutes, { stripe: opts.stripe })
  await app.register(validationRoutes, { stripe: opts.stripe })
  await app.register(logisticsRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
  await app.register(adminRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
  await app.register(walletRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
  await app.register(disputeRoutes, { stripe: opts.stripe, onAlert: opts.onAlert })
}

export default missionRoute
