import { FastifyPluginAsync } from 'fastify'
import { MissionStatus } from '../../generated/prisma'
import { prisma } from '../../db'
import { missionIdParamsSchema } from '../mission-common'
import { AppError } from '../../errors/app.error'

export const assignRoutes: FastifyPluginAsync = async app => {
  // POST /api/missions/:id/assign — voyageur s'assigne une mission CREATED → ACTIVE
  app.post('/:id/assign', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id: missionId } = req.params as { id: string }
    const travelerId = req.user.sub

    // 1. Pré-lecture : 404 si inexistante, 403 si le buyer s'auto-assigne.
    const mission = await prisma.mission.findUnique({ where: { id: missionId } })
    if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)
    if (mission.buyerId === travelerId) throw new AppError('FORBIDDEN', 403)

    // 2. Idempotence pre-tx : même voyageur, même mission → retry légitime → 200 direct.
    const existing = await prisma.processedAssignmentEvent.findUnique({
      where: { missionId },
    })
    if (existing?.travelerId === travelerId) {
      return reply.code(200).send({ status: MissionStatus.ACTIVE })
    }

    // 3. Transaction atomique : updateMany TOCTOU-safe + insert idempotence.
    await prisma.$transaction(async tx => {
      const result = await tx.mission.updateMany({
        where: { id: missionId, status: MissionStatus.CREATED },
        data: { status: MissionStatus.ACTIVE, travelerId },
      })

      if (result.count === 0) throw new AppError('MISSION_CONFLICT', 409)

      await tx.processedAssignmentEvent.create({
        data: { missionId, travelerId },
      })
    })

    return reply.code(200).send({ status: MissionStatus.ACTIVE })
  })
}
