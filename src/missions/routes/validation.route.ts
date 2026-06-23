import { FastifyPluginAsync } from 'fastify'
import { MissionStatus } from '../../generated/prisma'
import { prisma } from '../../db'
import { findMissionForBuyer } from '../mission-access'
import { captureEscrowFunds, EscrowCaptureError } from '../../services/escrow.service'
import {
  missionIdParamsSchema,
  MissionRouteOptions,
} from '../mission-common'
import { AppError } from '../../errors/app.error'

export const validationRoutes: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  // POST /api/missions/:id/validate
  app.post('/:id/validate', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

    if (
      mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
      mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
    ) {
      throw new AppError('CUSTOMS_REVIEW_PENDING', 409)
    }

    if (mission.status !== MissionStatus.AWAITING_VALIDATION) {
      throw new AppError('MISSION_NOT_AWAITING_VALIDATION', 400)
    }

    // Capture déléguée au service (source unique) : pré-check escrow HELD + montant
    // `amount_to_capture` exact (120% si substitution, budget sinon), clé `capture_<id>`.
    try {
      await captureEscrowFunds(mission.id, opts.stripe)
    } catch (err) {
      if (err instanceof EscrowCaptureError) throw new AppError('ESCROW_NOT_HELD', 400)
      throw err
    }

    await prisma.$transaction(async tx => {
      const updated = await tx.mission.updateMany({
        where: { id: mission.id, status: MissionStatus.AWAITING_VALIDATION },
        data: { status: MissionStatus.VALIDATED },
      })
      if (updated.count !== 1) throw new AppError('MISSION_NOT_AWAITING_VALIDATION', 400)
    })

    const validated = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(validated)
  })

  // POST /api/missions/:id/confirm-receipt
  app.post('/:id/confirm-receipt', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

    if (
      mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
      mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
    ) {
      throw new AppError('CUSTOMS_REVIEW_PENDING', 409)
    }

    if (mission.status !== MissionStatus.AWAITING_VALIDATION) {
      throw new AppError('MISSION_NOT_AWAITING_VALIDATION', 400)
    }

    // Jumeau de /validate : capture via le service (clé partagée `capture_<id>` →
    // un acheteur appelant /validate ET /confirm-receipt ne capture qu'une fois).
    try {
      await captureEscrowFunds(mission.id, opts.stripe)
    } catch (err) {
      if (err instanceof EscrowCaptureError) throw new AppError('ESCROW_NOT_HELD', 400)
      throw err
    }

    await prisma.$transaction(async tx => {
      const updated = await tx.mission.updateMany({
        where: { id: mission.id, status: MissionStatus.AWAITING_VALIDATION },
        data: { status: MissionStatus.VALIDATED },
      })
      if (updated.count !== 1) throw new AppError('MISSION_NOT_AWAITING_VALIDATION', 400)
    })

    const confirmed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(confirmed)
  })
}
