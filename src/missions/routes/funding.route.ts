import { FastifyPluginAsync } from 'fastify'
import { MissionStatus } from '../../generated/prisma'
import { prisma } from '../../db'
import { findMissionForBuyer } from '../mission-access'
import {
  missionIdParamsSchema,
  substitutionCeilingCents,
  checkFundingCapacity,
  isUniqueViolation,
  MissionRouteOptions,
} from '../mission-common'

export const fundingRoutes: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  // POST /api/missions/:id/intent — financement T0
  app.post('/:id/intent', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

    const existingEscrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: mission.id },
      select: { id: true },
    })
    if (existingEscrow) return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
    if (mission.status !== MissionStatus.CREATED) {
      return reply.code(400).send({ error: 'MISSION_NOT_FUNDABLE' })
    }

    const intentBody = (req.body ?? {}) as { stripeAuthorizationCents?: number }
    const intentCapacityError = await checkFundingCapacity(
      mission.id,
      mission.budgetCents,
      mission.commissionCents,
      intentBody.stripeAuthorizationCents,
    )
    if (intentCapacityError) {
      return reply.code(intentCapacityError.status).send({ error: intentCapacityError.code })
    }

    const heldBudgetCents = mission.substitutionAuthorized
      ? substitutionCeilingCents(mission.budgetCents)
      : mission.budgetCents
    const totalAmountCents = heldBudgetCents + mission.commissionCents

    const reserved = await prisma.mission.updateMany({
      where: { id: mission.id, status: MissionStatus.CREATED },
      data: { status: MissionStatus.FUNDED },
    })
    if (reserved.count !== 1) {
      return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
    }

    try {
      const intent = await opts.stripe.paymentIntents.create(
        {
          amount: totalAmountCents,
          currency: 'eur',
          capture_method: 'manual',
          metadata: { missionId: mission.id },
        },
        { idempotencyKey: `fund_${mission.id}` },
      )
      await prisma.escrowTransaction.create({
        data: {
          missionId: mission.id,
          stripePaymentIntentId: intent.id,
          spendingLimitCents: heldBudgetCents,
          idempotencyKey: `escrow_fund_${mission.id}`,
        },
      })
      return reply.code(200).send({
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        amountCents: totalAmountCents,
      })
    } catch (err) {
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

  // POST /api/missions/:id/checkout-session
  app.post(
    '/:id/checkout-session',
    { schema: { params: missionIdParamsSchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

      const existingEscrow = await prisma.escrowTransaction.findUnique({
        where: { missionId: mission.id },
        select: { id: true },
      })
      if (existingEscrow) return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
      if (mission.status !== MissionStatus.CREATED) {
        return reply.code(400).send({ error: 'MISSION_NOT_FUNDABLE' })
      }
      if (!opts.stripe.checkout) return reply.code(500).send({ error: 'CHECKOUT_UNAVAILABLE' })

      const checkoutBody = (req.body ?? {}) as { stripeAuthorizationCents?: number }
      const checkoutCapacityError = await checkFundingCapacity(
        mission.id,
        mission.budgetCents,
        mission.commissionCents,
        checkoutBody.stripeAuthorizationCents,
      )
      if (checkoutCapacityError) {
        return reply.code(checkoutCapacityError.status).send({ error: checkoutCapacityError.code })
      }

      const heldBudgetCents = mission.substitutionAuthorized
        ? substitutionCeilingCents(mission.budgetCents)
        : mission.budgetCents
      const totalAmountCents = heldBudgetCents + mission.commissionCents
      const frontendBaseUrl = process.env.FRONTEND_BASE_URL ?? 'http://localhost:3001'

      const reserved = await prisma.mission.updateMany({
        where: { id: mission.id, status: MissionStatus.CREATED },
        data: { status: MissionStatus.FUNDED },
      })
      if (reserved.count !== 1) {
        return reply.code(400).send({ error: 'MISSION_ALREADY_FUNDED' })
      }

      try {
        const session = await opts.stripe.checkout!.sessions.create(
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

        const piId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id
        if (!piId) throw new Error('CHECKOUT_NO_PAYMENT_INTENT')

        await prisma.escrowTransaction.create({
          data: {
            missionId: mission.id,
            stripePaymentIntentId: piId,
            spendingLimitCents: heldBudgetCents,
            idempotencyKey: `escrow_fund_${mission.id}`,
          },
        })
        return reply.code(200).send({ checkoutUrl: session.url, sessionId: session.id })
      } catch (err) {
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
}
