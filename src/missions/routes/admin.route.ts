import { FastifyPluginAsync } from 'fastify'
import { EscrowStatus, MissionStatus } from '../../generated/prisma'
import { prisma } from '../../db'
import { findMissionForBuyer } from '../mission-access'
import { safeEmit } from '../../alerts'
import {
  missionIdParamsSchema,
  disputeBodySchema,
  isRequestAdmin,
  MissionRouteOptions,
  DisputeBody,
} from '../mission-common'
import { createDisputeInTx, openDisputeInTx } from '../../services/dispute.service'
import { AppError } from '../../errors/app.error'

export const adminRoutes: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  // POST /api/missions/:id/customs-approve — validation ops/admin du verrou douanier.
  app.post('/:id/customs-approve', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      throw new AppError('FORBIDDEN', 403)
    }
    const { id } = req.params as { id: string }

    // Lecture initiale hors tx : fast-fail + récupération du stripePaymentIntentId.
    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      throw new AppError('ESCROW_NOT_HELD', 400)
    }

    // Capture Stripe HORS transaction — règle « no Stripe in DB tx ».
    // idempotencyKey déterministe : un retry ou un double appel admin ne crée pas deux débits.
    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `capture_customs_${id}` },
    )

    await prisma.$transaction(async tx => {
      // Garde 3a — re-vérification post-capture (aucun appel réseau dans la tx).
      // Théoriquement inatteignable : Stripe ne peut envoyer payment_intent.payment_failed
      // après une capture réussie (handlePaymentFailed WHERE capturedAmountCents=0).
      // Si cette garde se déclenche, c'est une violation d'invariant Stripe — signal
      // opérationnel fort, réconciliation manuelle requise.
      const escrowFresh = await tx.escrowTransaction.findUnique({
        where: { missionId: id },
        select: { status: true },
      })
      if (!escrowFresh || escrowFresh.status !== EscrowStatus.HELD) {
        safeEmit(opts.onAlert, {
          code: 'ESCROW_INVARIANT_VIOLATED',
          message: 'Escrow non-HELD après capture Stripe réussie — violation d\'invariant, réconciliation requise',
          details: { missionId: id, escrowStatus: escrowFresh?.status ?? 'NOT_FOUND' },
        })
        throw new AppError('ESCROW_INVARIANT_VIOLATED', 500)
      }

      const updated = await tx.mission.updateMany({
        where: { id, status: MissionStatus.PENDING_CUSTOMS_REVIEW },
        data: { status: MissionStatus.VALIDATED },
      })
      if (updated.count !== 1) throw new AppError('MISSION_NOT_CUSTOMS_REVIEW', 400)
      await tx.adminAuditLog.create({
        data: { adminId: req.user.sub, action: 'CUSTOMS_APPROVE', missionId: id },
      })
    })

    const approved = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(approved)
  })

  // POST /api/missions/:id/customs-reject — l'admin rejette la quittance soumise.
  app.post('/:id/customs-reject', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      throw new AppError('FORBIDDEN', 403)
    }
    const { id } = req.params as { id: string }

    await prisma.$transaction(async tx => {
      const updated = await tx.mission.updateMany({
        where: { id, status: MissionStatus.PENDING_CUSTOMS_REVIEW },
        data: {
          status: MissionStatus.ESCROW_LOCKED_CUSTOMS,
          customsReceiptUrl: null,
          customsReceiptSha256: null,
        },
      })
      if (updated.count !== 1) throw new AppError('MISSION_NOT_CUSTOMS_REVIEW', 400)
      await tx.adminAuditLog.create({
        data: { adminId: req.user.sub, action: 'CUSTOMS_REJECT', missionId: id },
      })
    })

    const rejected = await prisma.mission.findUniqueOrThrow({ where: { id } })
    safeEmit(opts.onAlert, {
      code: 'CUSTOMS_RECEIPT_REJECTED',
      message: 'Quittance douanière refusée — voyageur à notifier (nouvelle soumission attendue)',
      details: { missionId: id, travelerId: rejected.travelerId },
    })
    return reply.code(200).send(rejected)
  })

  // GET /api/missions/customs-pending — liste des missions PENDING_CUSTOMS_REVIEW (admin).
  app.get('/customs-pending', async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      throw new AppError('FORBIDDEN', 403)
    }
    const missions = await prisma.mission.findMany({
      where: { status: MissionStatus.PENDING_CUSTOMS_REVIEW },
      select: {
        id: true,
        budgetCents: true,
        purchaseAmountCents: true,
        destinationCountry: true,
        customsReceiptUrl: true,
        customsReceiptSha256: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
    })
    return reply.code(200).send(missions)
  })

  // POST /api/missions/:id/dispute — l'ACHETEUR ouvre un litige (DEPOSITED → DISPUTED).
  app.post(
    '/:id/dispute',
    { schema: { params: missionIdParamsSchema, body: disputeBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

      if (mission.status !== MissionStatus.DEPOSITED) {
        throw new AppError('INVALID_MISSION_STATE', 400)
      }

      const { disputeReason } = req.body as DisputeBody

      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.DEPOSITED },
          data: {
            status: MissionStatus.DISPUTED,
            disputeReason: disputeReason ?? null,
            disputedAt: new Date(),
          },
        })
        if (updated.count !== 1) throw new AppError('INVALID_MISSION_STATE', 400)
        // Créer + ouvrir le litige structuré atomiquement avec la mise à jour mission.
        // Si l'une de ces étapes échoue, toute la transaction est annulée — la mission
        // ne peut pas rester DISPUTED sans Dispute row (cohérence garantie).
        await createDisputeInTx(tx, mission.id, req.user.sub, disputeReason)
        await openDisputeInTx(tx, mission.id)
        await tx.adminAuditLog.create({
          data: { adminId: req.user.sub, action: 'DISPUTE_OPENED', missionId: mission.id },
        })
      })

      const disputed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      safeEmit(opts.onAlert, {
        code: 'MISSION_DISPUTED_BY_BUYER',
        message: 'Litige ouvert par l\'acheteur sur une mission déposée — fonds gelés, arbitrage humain requis',
        details: { missionId: id, buyerId: mission.buyerId, travelerId: mission.travelerId },
      })
      return reply.code(200).send(disputed)
    },
  )

  // POST /api/missions/:id/admin/resolve-refund — ARBITRAGE en faveur de l'ACHETEUR (cancel hold).
  app.post('/:id/admin/resolve-refund', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      throw new AppError('FORBIDDEN', 403)
    }
    const { id } = req.params as { id: string }

    const mission = await prisma.mission.findUnique({ where: { id }, select: { status: true } })
    if (!mission || mission.status !== MissionStatus.DISPUTED) {
      throw new AppError('MISSION_NOT_DISPUTED', 400)
    }

    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      throw new AppError('ESCROW_NOT_HELD', 400)
    }
    if (!opts.stripe.paymentIntents.cancel) {
      throw new AppError('REFUND_UNAVAILABLE', 500)
    }

    await opts.stripe.paymentIntents.cancel(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `admin_refund_${id}` },
    )

    await prisma.$transaction(async tx => {
      const updated = await tx.mission.updateMany({
        where: { id, status: MissionStatus.DISPUTED },
        data: { status: MissionStatus.CANCELLED },
      })
      if (updated.count !== 1) throw new AppError('MISSION_NOT_DISPUTED', 400)
      await tx.adminAuditLog.create({
        data: { adminId: req.user.sub, action: 'ADMIN_RESOLVE_REFUND', missionId: id },
      })
    })

    const resolved = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(resolved)
  })

  // POST /api/missions/:id/admin/resolve-payout — ARBITRAGE en faveur du VOYAGEUR (capture).
  app.post('/:id/admin/resolve-payout', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    if (!(await isRequestAdmin(req.user.sub))) {
      throw new AppError('FORBIDDEN', 403)
    }
    const { id } = req.params as { id: string }

    const mission = await prisma.mission.findUnique({ where: { id }, select: { status: true } })
    if (!mission || mission.status !== MissionStatus.DISPUTED) {
      throw new AppError('MISSION_NOT_DISPUTED', 400)
    }

    const escrow = await prisma.escrowTransaction.findUnique({
      where: { missionId: id },
      select: { stripePaymentIntentId: true, status: true },
    })
    if (!escrow || escrow.status !== EscrowStatus.HELD) {
      throw new AppError('ESCROW_NOT_HELD', 400)
    }

    await opts.stripe.paymentIntents.capture(
      escrow.stripePaymentIntentId,
      {},
      { idempotencyKey: `admin_payout_${id}` },
    )

    await prisma.$transaction(async tx => {
      const updated = await tx.mission.updateMany({
        where: { id, status: MissionStatus.DISPUTED },
        data: { status: MissionStatus.VALIDATED },
      })
      if (updated.count !== 1) throw new AppError('MISSION_NOT_DISPUTED', 400)
      await tx.adminAuditLog.create({
        data: { adminId: req.user.sub, action: 'ADMIN_RESOLVE_PAYOUT', missionId: id },
      })
    })

    const resolved = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(resolved)
  })
}
