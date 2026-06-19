import { FastifyPluginAsync } from 'fastify'
import { MissionStatus } from '../../generated/prisma'
import { prisma } from '../../db'
import { findMissionForBuyer } from '../mission-access'
import { captureEscrowFunds, EscrowCaptureError } from '../../services/escrow.service'
import {
  missionIdParamsSchema,
  ValidationConflictError,
  ConfirmReceiptConflictError,
  MissionRouteOptions,
} from '../mission-common'

export const validationRoutes: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  // POST /api/missions/:id/validate
  app.post('/:id/validate', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

    if (
      mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
      mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
    ) {
      return reply.code(409).send({ error: 'CUSTOMS_REVIEW_PENDING' })
    }

    if (mission.status !== MissionStatus.AWAITING_VALIDATION) {
      return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
    }

    // Capture déléguée au service (source unique) : pré-check escrow HELD + montant
    // `amount_to_capture` exact (120% si substitution, budget sinon), clé `capture_<id>`.
    try {
      await captureEscrowFunds(mission.id, opts.stripe)
    } catch (err) {
      if (err instanceof EscrowCaptureError) {
        return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
      }
      throw err
    }

    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.AWAITING_VALIDATION },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new ValidationConflictError()
      })
    } catch (err) {
      if (err instanceof ValidationConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
      }
      throw err
    }

    const validated = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(validated)
  })

  // POST /api/missions/:id/confirm-receipt
  app.post('/:id/confirm-receipt', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForBuyer(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

    if (
      mission.status === MissionStatus.ESCROW_LOCKED_CUSTOMS ||
      mission.status === MissionStatus.PENDING_CUSTOMS_REVIEW
    ) {
      return reply.code(409).send({ error: 'CUSTOMS_REVIEW_PENDING' })
    }

    if (mission.status !== MissionStatus.AWAITING_VALIDATION) {
      return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
    }

    // Jumeau de /validate : capture via le service (clé partagée `capture_<id>` →
    // un acheteur appelant /validate ET /confirm-receipt ne capture qu'une fois).
    try {
      await captureEscrowFunds(mission.id, opts.stripe)
    } catch (err) {
      if (err instanceof EscrowCaptureError) {
        return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
      }
      throw err
    }

    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.AWAITING_VALIDATION },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new ConfirmReceiptConflictError()
      })
    } catch (err) {
      if (err instanceof ConfirmReceiptConflictError) {
        return reply.code(400).send({ error: 'MISSION_NOT_AWAITING_VALIDATION' })
      }
      throw err
    }

    const confirmed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    return reply.code(200).send(confirmed)
  })
}
