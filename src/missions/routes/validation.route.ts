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

/**
 * Schema body commun aux deux endpoints acheteur qui portent le garde-fou de
 * concurrence optimiste. `expectedVersion` est optionnel pour la rétrocompat :
 * si absent (body null ou {}) la transition s'effectue sans contrôle de version.
 * Si présent, une divergence déclenche un 409.
 *
 * `anyOf` + null : accepte un body absent (Content-Type omis → null côté Fastify)
 * tout en validant le shape quand un body est fourni.
 */
const versionBodySchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        expectedVersion: { type: 'integer', minimum: 0 },
      },
    },
    { type: 'null' },
  ],
} as const

/**
 * Vérifie la version cliente et lève 409 VERSION_CONFLICT si dépassée.
 * Doit être appelé AVANT tout appel Stripe (règle : aucun appel Stripe dans
 * une transaction, et le fail-fast coûte moins qu'une capture annulée).
 */
function assertVersion(
  mission: { id: string; version: number },
  expectedVersion: number | undefined,
): void {
  if (expectedVersion !== undefined && expectedVersion !== mission.version) {
    throw new AppError('VERSION_CONFLICT', 409, {
      currentVersion: mission.version,
      expectedVersion,
    })
  }
}

export const validationRoutes: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  // POST /api/missions/:id/validate
  app.post(
    '/:id/validate',
    { schema: { params: missionIdParamsSchema, body: versionBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const expectedVersion = (req.body as { expectedVersion?: number } | null)?.expectedVersion
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

      // Fail-fast avant Stripe : si la version est dépassée, inutile de capturer.
      assertVersion(mission, expectedVersion)

      try {
        await captureEscrowFunds(mission.id, opts.stripe)
      } catch (err) {
        if (err instanceof EscrowCaptureError) throw new AppError('ESCROW_NOT_HELD', 400)
        throw err
      }

      await prisma.$transaction(async tx => {
        const where = expectedVersion !== undefined
          ? { id: mission.id, status: MissionStatus.AWAITING_VALIDATION, version: expectedVersion }
          : { id: mission.id, status: MissionStatus.AWAITING_VALIDATION }

        const updated = await tx.mission.updateMany({
          where,
          data: { status: MissionStatus.VALIDATED, version: { increment: 1 } },
        })

        if (updated.count !== 1) {
          // Distinguer un conflit de version d'un conflit de statut.
          if (expectedVersion !== undefined) {
            const current = await tx.mission.findUnique({
              where: { id: mission.id },
              select: { version: true },
            })
            if (current && current.version !== expectedVersion) {
              throw new AppError('VERSION_CONFLICT', 409, {
                currentVersion: current.version,
                expectedVersion,
              })
            }
          }
          throw new AppError('MISSION_NOT_AWAITING_VALIDATION', 400)
        }
      })

      const validated = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply.code(200).send(validated)
    },
  )

  // POST /api/missions/:id/confirm-receipt
  app.post(
    '/:id/confirm-receipt',
    { schema: { params: missionIdParamsSchema, body: versionBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const expectedVersion = (req.body as { expectedVersion?: number } | null)?.expectedVersion
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

      // Fail-fast avant Stripe : si la version est dépassée, inutile de capturer.
      assertVersion(mission, expectedVersion)

      // Jumeau de /validate : capture via le service (clé partagée `capture_<id>` →
      // un acheteur appelant /validate ET /confirm-receipt ne capture qu'une fois).
      try {
        await captureEscrowFunds(mission.id, opts.stripe)
      } catch (err) {
        if (err instanceof EscrowCaptureError) throw new AppError('ESCROW_NOT_HELD', 400)
        throw err
      }

      await prisma.$transaction(async tx => {
        const where = expectedVersion !== undefined
          ? { id: mission.id, status: MissionStatus.AWAITING_VALIDATION, version: expectedVersion }
          : { id: mission.id, status: MissionStatus.AWAITING_VALIDATION }

        const updated = await tx.mission.updateMany({
          where,
          data: { status: MissionStatus.VALIDATED, version: { increment: 1 } },
        })

        if (updated.count !== 1) {
          if (expectedVersion !== undefined) {
            const current = await tx.mission.findUnique({
              where: { id: mission.id },
              select: { version: true },
            })
            if (current && current.version !== expectedVersion) {
              throw new AppError('VERSION_CONFLICT', 409, {
                currentVersion: current.version,
                expectedVersion,
              })
            }
          }
          throw new AppError('MISSION_NOT_AWAITING_VALIDATION', 400)
        }
      })

      const confirmed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply.code(200).send(confirmed)
    },
  )
}
