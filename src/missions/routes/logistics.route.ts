import { createHash, randomBytes } from 'node:crypto'
import { FastifyPluginAsync } from 'fastify'
import {
  DropOffType,
  MissionStatus,
  SubstitutionStatus,
} from '../../generated/prisma'
import { prisma } from '../../db'
import {
  findMissionForTraveler,
  findMissionForBuyer,
  findMissionForParticipant,
} from '../mission-access'
import { captureEscrowFunds, EscrowCaptureError } from '../../services/escrow.service'
import { getCustomsThreshold } from '../customs'
import { hashQrCode, qrCodeMatches } from '../qr-proof'
import {
  missionIdParamsSchema,
  customsReceiptBodySchema,
  dropoffReceiptBodySchema,
  shipBodySchema,
  submitReceiptBodySchema,
  dropOffBodySchema,
  reviewBodySchema,
  rateLimit,
  substitutionCeilingCents,
  isUniqueViolation,
  travelerHasGuaranteeCard,
  MissionRouteOptions,
  CustomsReceiptBody,
  DropoffReceiptBody,
  ShipBody,
  SubmitReceiptBody,
  ReviewBody,
  MatchConflictError,
  ReceiptConflictError,
  ReceiveConflictError,
  CustomsConflictError,
  DropoffConflictError,
  CollectionConflictError,
  LogisticsDropOffNotFoundError,
  LogisticsDropOffStatusError,
  LogisticsDropOffConflictError,
  ReviewNotFoundError,
  ReviewNotTerminalError,
  ReviewNoTravelerError,
} from '../mission-common'

interface DropOffBody {
  dropOffType: DropOffType
  dropOffCarrier: string
  dropOffTrackingId: string
  dropOffAccessCode?: string
}

export const logisticsRoutes: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  // POST /api/missions/:id/match — un VOYAGEUR prend la mission.
  app.post('/:id/match', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user.sub
    const mission = await prisma.mission.findUnique({ where: { id } })
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
    if (mission.buyerId === userId) {
      return reply.code(400).send({ error: 'CANNOT_MATCH_OWN_MISSION' })
    }
    if (mission.status !== MissionStatus.FUNDED) {
      const code =
        mission.status === MissionStatus.CREATED ? 'MISSION_NOT_MATCHABLE' : 'MISSION_ALREADY_MATCHED'
      return reply.code(400).send({ error: code })
    }

    if (!(await travelerHasGuaranteeCard(userId))) {
      return reply.code(400).send({ error: 'TRAVELER_CARD_MISSING' })
    }

    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id, status: MissionStatus.FUNDED, travelerId: null },
          data: { travelerId: userId, status: MissionStatus.MATCHED },
        })
        if (updated.count !== 1) throw new MatchConflictError()
      })
    } catch (err) {
      if (err instanceof MatchConflictError) {
        return reply.code(400).send({ error: 'MISSION_ALREADY_MATCHED' })
      }
      throw err
    }

    const matched = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(matched)
  })

  // POST /api/missions/:id/accept — un VOYAGEUR accepte le transport (miroir de /match).
  app.post('/:id/accept', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user.sub
    const mission = await prisma.mission.findUnique({ where: { id } })
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
    if (mission.buyerId === userId) {
      return reply.code(400).send({ error: 'CANNOT_MATCH_OWN_MISSION' })
    }
    if (mission.status !== MissionStatus.FUNDED) {
      const code =
        mission.status === MissionStatus.CREATED ? 'MISSION_NOT_MATCHABLE' : 'MISSION_ALREADY_MATCHED'
      return reply.code(400).send({ error: code })
    }

    if (!(await travelerHasGuaranteeCard(userId))) {
      return reply.code(400).send({ error: 'TRAVELER_CARD_MISSING' })
    }

    try {
      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id, status: MissionStatus.FUNDED, travelerId: null },
          data: { travelerId: userId, status: MissionStatus.MATCHED },
        })
        if (updated.count !== 1) throw new MatchConflictError()
      })
    } catch (err) {
      if (err instanceof MatchConflictError) {
        return reply.code(400).send({ error: 'MISSION_ALREADY_MATCHED' })
      }
      throw err
    }

    const accepted = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(accepted)
  })

  // POST /api/missions/:id/start-travel — le VOYAGEUR assigné passe à l'action.
  app.post('/:id/start-travel', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForTraveler(prisma, id, req.user.sub)
    if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

    const updated = await prisma.mission.updateMany({
      where: { id, travelerId: req.user.sub, status: MissionStatus.MATCHED },
      data: { status: MissionStatus.IN_PROGRESS },
    })
    if (updated.count !== 1) {
      return reply.code(400).send({ error: 'MISSION_NOT_MATCHED' })
    }

    const started = await prisma.mission.findUniqueOrThrow({ where: { id } })
    return reply.code(200).send(started)
  })

  // POST /api/missions/:id/ship — le VOYAGEUR déclare le dépôt + génère le sceau QR.
  app.post(
    '/:id/ship',
    { schema: { params: missionIdParamsSchema, body: shipBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
      if (mission.status !== MissionStatus.MATCHED) {
        return reply.code(400).send({ error: 'MISSION_NOT_MATCHED' })
      }

      const { trackingReference, purchaseAmountCents } = req.body as ShipBody
      if (purchaseAmountCents > mission.budgetCents) {
        return reply.code(400).send({ error: 'RECEIPT_AMOUNT_EXCEEDS_BUDGET' })
      }

      // Sceau QR interne (anti « colis vide ») : code aléatoire 256 bits, seul le
      // sha256 persisté ; brut renvoyé UNE SEULE FOIS pour impression/scellage.
      const innerQrCode = randomBytes(32).toString('hex')
      const innerQrCodeHash = hashQrCode(innerQrCode)

      const updated = await prisma.mission.updateMany({
        where: { id, travelerId: req.user.sub, status: MissionStatus.MATCHED },
        data: {
          status: MissionStatus.IN_PROGRESS,
          trackingReference,
          purchaseAmountCents,
          innerQrCodeHash,
        },
      })
      if (updated.count !== 1) {
        return reply.code(400).send({ error: 'MISSION_NOT_MATCHED' })
      }

      const shipped = await prisma.mission.findUniqueOrThrow({ where: { id } })
      return reply.code(200).send({ ...shipped, innerQrCode })
    },
  )

  // POST /api/missions/:id/submit-receipt — le VOYAGEUR scelle son reçu d'achat.
  app.post(
    '/:id/submit-receipt',
    { schema: { params: missionIdParamsSchema, body: submitReceiptBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
      if (mission.status !== MissionStatus.IN_PROGRESS) {
        return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
      }

      const { urlRecu, purchaseAmountCents } = req.body as SubmitReceiptBody

      const isSubstitution = purchaseAmountCents > mission.budgetCents
      if (isSubstitution) {
        if (!mission.substitutionAuthorized) {
          return reply.code(400).send({ error: 'RECEIPT_AMOUNT_EXCEEDS_BUDGET' })
        }
        if (purchaseAmountCents > substitutionCeilingCents(mission.budgetCents)) {
          return reply.code(400).send({ error: 'SUBSTITUTION_PRICE_EXCEEDS_LIMIT' })
        }
      }
      const sha256Server = createHash('sha256')
        .update(`${mission.id}:${urlRecu}:${purchaseAmountCents}`)
        .digest('hex')

      try {
        await prisma.$transaction(async tx => {
          await tx.receipt.create({
            data: {
              missionId: mission.id,
              totalTtcCents: purchaseAmountCents,
              receiptUrl: urlRecu,
              sha256Client: sha256Server,
              sha256Server,
              sealedAt: new Date(),
            },
          })
          if (isSubstitution) {
            await tx.substitutionRequest.create({
              data: {
                missionId: mission.id,
                lineItemRef: 'MAIN',
                proposedProduct: mission.targetProduct,
                proposedPriceCents: purchaseAmountCents,
                status: SubstitutionStatus.APPROVED,
                resolvedAt: new Date(),
              },
            })
          }
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.IN_PROGRESS },
            data: { status: MissionStatus.AWAITING_VALIDATION },
          })
          if (updated.count !== 1) throw new ReceiptConflictError()
        })
      } catch (err) {
        if (err instanceof ReceiptConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
        }
        if (isUniqueViolation(err)) {
          return reply.code(400).send({ error: 'RECEIPT_ALREADY_SUBMITTED' })
        }
        throw err
      }

      const receipt = await prisma.receipt.findUniqueOrThrow({ where: { missionId: mission.id } })
      return reply.code(201).send(receipt)
    },
  )

  // POST /api/missions/:id/receive — l'ACHETEUR confirme la réception (capture).
  app.post(
    '/:id/receive',
    { schema: { params: missionIdParamsSchema }, preHandler: rateLimit('receive') },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

      if (mission.status !== MissionStatus.IN_PROGRESS) {
        return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
      }

      // Contrôle douanier : verrou AVANT capture si valeur déclarée > seuil.
      if (mission.destinationCountry && !mission.customsReceiptUrl) {
        const thresholdCents = getCustomsThreshold(mission.destinationCountry) * 100
        const declaredCents = mission.purchaseAmountCents ?? mission.budgetCents
        if (declaredCents > thresholdCents) {
          const locked = await prisma.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.IN_PROGRESS },
            data: { status: MissionStatus.ESCROW_LOCKED_CUSTOMS },
          })
          if (locked.count !== 1) {
            return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
          }
          const lockedMission = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
          return reply.code(200).send(lockedMission)
        }
      }

      // Capture via le service (source unique) : pré-check escrow HELD + montant
      // `amount_to_capture` exact, clé partagée `capture_<id>`.
      try {
        await captureEscrowFunds(mission.id, opts.stripe)
      } catch (err) {
        if (err instanceof EscrowCaptureError) {
          return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
        }
        throw err
      }

      const saleCertificate = JSON.stringify({
        transactionId: mission.id,
        voyageurImportateurId: mission.travelerId,
        acheteurFinalId: mission.buyerId,
        prixAchatCents: mission.budgetCents,
        margeCents: mission.commissionCents,
      })
      const saleSignature = createHash('sha256').update(saleCertificate).digest('hex')

      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.IN_PROGRESS },
            data: { status: MissionStatus.VALIDATED, saleSignature },
          })
          if (updated.count !== 1) throw new ReceiveConflictError()
        })
      } catch (err) {
        if (err instanceof ReceiveConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
        }
        throw err
      }

      const received = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply.code(200).send(received)
    },
  )

  // POST /api/missions/:id/customs-receipt — le VOYAGEUR téléverse la preuve de taxes.
  app.post(
    '/:id/customs-receipt',
    {
      schema: { params: missionIdParamsSchema, body: customsReceiptBodySchema },
      preHandler: rateLimit('customs-receipt'),
    },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
      if (mission.status !== MissionStatus.ESCROW_LOCKED_CUSTOMS) {
        return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_LOCKED' })
      }

      const { customsReceiptUrl, customsReceiptSha256 } = req.body as CustomsReceiptBody

      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.ESCROW_LOCKED_CUSTOMS },
            data: {
              status: MissionStatus.PENDING_CUSTOMS_REVIEW,
              customsReceiptUrl,
              customsReceiptSha256,
            },
          })
          if (updated.count !== 1) throw new CustomsConflictError()
        })
      } catch (err) {
        if (err instanceof CustomsConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_CUSTOMS_LOCKED' })
        }
        throw err
      }

      const reviewing = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply.code(200).send(reviewing)
    },
  )

  // POST /api/missions/:id/dropoff-receipt — le VOYAGEUR enregistre le dépôt du colis.
  const DROPOFF_ALLOWED_STATUSES: MissionStatus[] = [
    MissionStatus.MATCHED,
    MissionStatus.VALIDATED,
  ]
  app.post(
    '/:id/dropoff-receipt',
    { schema: { params: missionIdParamsSchema, body: dropoffReceiptBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForTraveler(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

      if (!DROPOFF_ALLOWED_STATUSES.includes(mission.status)) {
        return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
      }

      const { dropoffReceiptUrl, dropoffTrackingNumber } = req.body as DropoffReceiptBody

      // Sceau QR IDEMPOTENT : généré ici si /ship ne l'a pas posé, jamais écrasé.
      const newInnerQrCode = mission.innerQrCodeHash ? null : randomBytes(32).toString('hex')

      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: { in: DROPOFF_ALLOWED_STATUSES } },
            data: {
              status: MissionStatus.DEPOSITED,
              dropoffReceiptUrl,
              dropoffTrackingNumber: dropoffTrackingNumber ?? null,
              dropoffAt: new Date(),
              ...(newInnerQrCode ? { innerQrCodeHash: hashQrCode(newInnerQrCode) } : {}),
            },
          })
          if (updated.count !== 1) throw new DropoffConflictError()
        })
      } catch (err) {
        if (err instanceof DropoffConflictError) {
          return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
        }
        throw err
      }

      const deposited = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply
        .code(200)
        .send(newInnerQrCode ? { ...deposited, innerQrCode: newInnerQrCode } : deposited)
    },
  )

  // POST /api/missions/:id/confirm-collection — l'ACHETEUR confirme la collecte (capture + vérif QR).
  app.post(
    '/:id/confirm-collection',
    { schema: { params: missionIdParamsSchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })

      if (mission.status !== MissionStatus.DEPOSITED) {
        return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
      }

      // Preuve QR interne (anti « colis vide ») : vérif temps constant AVANT capture.
      if (mission.innerQrCodeHash) {
        const raw = (req.body as { innerQrCode?: unknown } | null)?.innerQrCode
        if (
          typeof raw !== 'string' ||
          raw.length === 0 ||
          raw.length > 512 ||
          !qrCodeMatches(raw, mission.innerQrCodeHash)
        ) {
          return reply.code(400).send({ error: 'INVALID_QR_PROOF' })
        }
      }

      // Capture via le service (source unique) : pré-check escrow HELD + montant
      // `amount_to_capture` exact, clé dédiée au chemin collecte.
      try {
        await captureEscrowFunds(mission.id, opts.stripe, `capture_collection_${mission.id}`)
      } catch (err) {
        if (err instanceof EscrowCaptureError) {
          return reply.code(400).send({ error: 'ESCROW_NOT_HELD' })
        }
        throw err
      }

      try {
        await prisma.$transaction(async tx => {
          const updated = await tx.mission.updateMany({
            where: { id: mission.id, status: MissionStatus.DEPOSITED },
            data: { status: MissionStatus.VALIDATED },
          })
          if (updated.count !== 1) throw new CollectionConflictError()
        })
      } catch (err) {
        if (err instanceof CollectionConflictError) {
          return reply.code(400).send({ error: 'INVALID_MISSION_STATE' })
        }
        throw err
      }

      const confirmed = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply.code(200).send(confirmed)
    },
  )

  // POST /:id/drop-off — dépôt logistique tiers (casier/relais/poste). Voyageur assigné.
  app.post<{ Params: { id: string }; Body: DropOffBody }>(
    '/:id/drop-off',
    { schema: { body: dropOffBodySchema } },
    async (req, reply) => {
      const { id } = req.params
      const userId = req.user.sub
      const { dropOffType, dropOffCarrier, dropOffTrackingId, dropOffAccessCode } = req.body

      try {
        await prisma.$transaction(async tx => {
          const mission = await findMissionForTraveler(tx, id, userId)
          if (!mission) throw new LogisticsDropOffNotFoundError()

          if (mission.status !== MissionStatus.IN_PROGRESS) {
            throw new LogisticsDropOffStatusError()
          }

          const updated = await tx.mission.updateMany({
            where: { id, status: MissionStatus.IN_PROGRESS },
            data: {
              dropOffType,
              dropOffCarrier,
              dropOffTrackingId,
              dropOffAccessCode,
              droppedAt: new Date(),
              status: MissionStatus.AWAITING_VALIDATION,
            },
          })
          if (updated.count !== 1) throw new LogisticsDropOffConflictError()
        })
      } catch (err) {
        if (err instanceof LogisticsDropOffNotFoundError) {
          return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
        }
        if (err instanceof LogisticsDropOffStatusError || err instanceof LogisticsDropOffConflictError) {
          return reply.code(400).send({ error: 'MISSION_NOT_IN_PROGRESS' })
        }
        throw err
      }

      const mission = await prisma.mission.findUniqueOrThrow({ where: { id } })
      return reply.code(200).send({
        status: mission.status,
        droppedAt: mission.droppedAt,
        dropOffType: mission.dropOffType,
        dropOffCarrier: mission.dropOffCarrier,
        dropOffTrackingId: mission.dropOffTrackingId,
      })
    },
  )

  // POST /:id/reviews — notation mutuelle post-clôture (RELEASED ou CANCELLED).
  app.post<{ Params: { id: string }; Body: ReviewBody }>(
    '/:id/reviews',
    { schema: { body: reviewBodySchema } },
    async (req, reply) => {
      const { id } = req.params
      const userId = req.user.sub
      const { rating, comment } = req.body

      let review
      try {
        review = await prisma.$transaction(async tx => {
          const access = await findMissionForParticipant(tx, id, userId)
          if (!access) throw new ReviewNotFoundError()

          const { mission, relation } = access
          if (
            mission.status !== MissionStatus.RELEASED &&
            mission.status !== MissionStatus.CANCELLED
          ) {
            throw new ReviewNotTerminalError()
          }

          let targetId: string
          if (relation === 'buyer') {
            if (!mission.travelerId) throw new ReviewNoTravelerError()
            targetId = mission.travelerId
          } else {
            targetId = mission.buyerId
          }

          return tx.review.create({
            data: { missionId: id, authorId: userId, targetId, rating, comment },
          })
        })
      } catch (err) {
        if (err instanceof ReviewNotFoundError) {
          return reply.code(404).send({ error: 'MISSION_NOT_FOUND' })
        }
        if (err instanceof ReviewNotTerminalError) {
          return reply.code(400).send({ error: 'MISSION_NOT_TERMINAL' })
        }
        if (err instanceof ReviewNoTravelerError) {
          return reply.code(400).send({ error: 'NO_TRAVELER_ASSIGNED' })
        }
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'REVIEW_ALREADY_SUBMITTED' })
        }
        throw err
      }

      return reply.code(201).send(review)
    },
  )
}
