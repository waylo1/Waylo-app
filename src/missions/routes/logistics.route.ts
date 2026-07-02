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
  innerQrBodySchema,
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
  InnerQrBody,
} from '../mission-common'
import { AppError } from '../../errors/app.error'
import { notifyActor } from '../../notifications/notification.service'

interface DropOffBody {
  dropOffType: DropOffType
  dropOffCarrier: string
  dropOffTrackingId: string
  dropOffAccessCode?: string
}

/**
 * Sceau QR interne anti-colis-vide — vérification en temps constant AVANT capture.
 * Partagé par /receive et /confirm-collection : aucune divergence possible.
 * Throws AppError('NO_INNER_SEAL', 400) si la mission n'a pas de sceau.
 * Throws AppError('INVALID_QR_PROOF', 400) si le code soumis ne correspond pas.
 */
function verifyInnerSeal(innerQrCode: string, storedHash: string | null): void {
  if (!storedHash) throw new AppError('NO_INNER_SEAL', 400)
  if (!qrCodeMatches(innerQrCode, storedHash)) throw new AppError('INVALID_QR_PROOF', 400)
}

export const logisticsRoutes: FastifyPluginAsync<MissionRouteOptions> = async (app, opts) => {
  // POST /api/missions/:id/match — un VOYAGEUR prend la mission.
  app.post('/:id/match', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user.sub
    const mission = await prisma.mission.findUnique({ where: { id } })
    if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)
    if (mission.buyerId === userId) {
      throw new AppError('CANNOT_MATCH_OWN_MISSION', 400)
    }
    if (mission.status !== MissionStatus.FUNDED) {
      const code =
        mission.status === MissionStatus.CREATED ? 'MISSION_NOT_MATCHABLE' : 'MISSION_ALREADY_MATCHED'
      throw new AppError(code, 400)
    }

    if (!(await travelerHasGuaranteeCard(userId))) {
      throw new AppError('TRAVELER_CARD_MISSING', 400)
    }

    await prisma.$transaction(async tx => {
      const updated = await tx.mission.updateMany({
        where: { id, status: MissionStatus.FUNDED, travelerId: null },
        data: { travelerId: userId, status: MissionStatus.MATCHED },
      })
      if (updated.count !== 1) throw new AppError('MISSION_ALREADY_MATCHED', 400)
    })

    const matched = await prisma.mission.findUniqueOrThrow({ where: { id } })

    // Fire-and-forget post-commit (hook ré-câblé depuis l'ex-/assign supprimé) :
    // notifie l'acheteur que sa mission est prise. Idempotent (ProcessedMissionEvent).
    notifyActor(
      'notif:mission-matched',
      matched.id,
      matched.buyerId,
      { event: 'notif:mission-matched', missionId: matched.id, targetProduct: matched.targetProduct, destination: matched.destination },
    ).catch(err => console.error({ err, missionId: matched.id }, '[notif] mission-matched failed'))

    return reply.code(200).send(matched)
  })

  // POST /api/missions/:id/accept — un VOYAGEUR accepte le transport (miroir de /match).
  app.post('/:id/accept', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const userId = req.user.sub
    const mission = await prisma.mission.findUnique({ where: { id } })
    if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)
    if (mission.buyerId === userId) {
      throw new AppError('CANNOT_MATCH_OWN_MISSION', 400)
    }
    if (mission.status !== MissionStatus.FUNDED) {
      const code =
        mission.status === MissionStatus.CREATED ? 'MISSION_NOT_MATCHABLE' : 'MISSION_ALREADY_MATCHED'
      throw new AppError(code, 400)
    }

    if (!(await travelerHasGuaranteeCard(userId))) {
      throw new AppError('TRAVELER_CARD_MISSING', 400)
    }

    await prisma.$transaction(async tx => {
      const updated = await tx.mission.updateMany({
        where: { id, status: MissionStatus.FUNDED, travelerId: null },
        data: { travelerId: userId, status: MissionStatus.MATCHED },
      })
      if (updated.count !== 1) throw new AppError('MISSION_ALREADY_MATCHED', 400)
    })

    const accepted = await prisma.mission.findUniqueOrThrow({ where: { id } })

    // Fire-and-forget post-commit (hook ré-câblé depuis l'ex-/assign supprimé) :
    // notifie l'acheteur que sa mission est prise. Idempotent (ProcessedMissionEvent).
    notifyActor(
      'notif:mission-matched',
      accepted.id,
      accepted.buyerId,
      { event: 'notif:mission-matched', missionId: accepted.id, targetProduct: accepted.targetProduct, destination: accepted.destination },
    ).catch(err => console.error({ err, missionId: accepted.id }, '[notif] mission-matched failed'))

    return reply.code(200).send(accepted)
  })

  // POST /api/missions/:id/start-travel — le VOYAGEUR assigné passe à l'action.
  app.post('/:id/start-travel', { schema: { params: missionIdParamsSchema } }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const mission = await findMissionForTraveler(prisma, id, req.user.sub)
    if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

    const updated = await prisma.mission.updateMany({
      where: { id, travelerId: req.user.sub, status: MissionStatus.MATCHED },
      data: { status: MissionStatus.IN_PROGRESS },
    })
    if (updated.count !== 1) {
      throw new AppError('MISSION_NOT_MATCHED', 400)
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
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)
      if (mission.status !== MissionStatus.MATCHED) {
        throw new AppError('MISSION_NOT_MATCHED', 400)
      }

      const { trackingReference, purchaseAmountCents } = req.body as ShipBody
      if (purchaseAmountCents > mission.budgetCents) {
        throw new AppError('RECEIPT_AMOUNT_EXCEEDS_BUDGET', 400)
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
          // Watchdog : deadline de réception auto-refund posée une seule fois à l'expédition.
          autoRefundDeadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
        },
      })
      if (updated.count !== 1) {
        throw new AppError('MISSION_NOT_MATCHED', 400)
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
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)
      if (mission.status !== MissionStatus.IN_PROGRESS) {
        throw new AppError('MISSION_NOT_IN_PROGRESS', 400)
      }

      const { urlRecu, purchaseAmountCents } = req.body as SubmitReceiptBody

      const isSubstitution = purchaseAmountCents > mission.budgetCents
      if (isSubstitution) {
        if (!mission.substitutionAuthorized) {
          throw new AppError('RECEIPT_AMOUNT_EXCEEDS_BUDGET', 400)
        }
        if (purchaseAmountCents > substitutionCeilingCents(mission.budgetCents)) {
          throw new AppError('SUBSTITUTION_PRICE_EXCEEDS_LIMIT', 400)
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
          if (updated.count !== 1) throw new AppError('MISSION_NOT_IN_PROGRESS', 400)
        })
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError('RECEIPT_ALREADY_SUBMITTED', 400)
        throw err
      }

      const receipt = await prisma.receipt.findUniqueOrThrow({ where: { missionId: mission.id } })
      return reply.code(201).send(receipt)
    },
  )

  // POST /api/missions/:id/receive — l'ACHETEUR confirme la réception (capture).
  app.post(
    '/:id/receive',
    { schema: { params: missionIdParamsSchema, body: innerQrBodySchema }, preHandler: rateLimit('receive') },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

      if (mission.status !== MissionStatus.IN_PROGRESS) {
        throw new AppError('MISSION_NOT_IN_PROGRESS', 400)
      }

      // Sceau QR interne : vérification en temps constant AVANT toute capture ou verrou.
      verifyInnerSeal((req.body as InnerQrBody).innerQrCode, mission.innerQrCodeHash)

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
            throw new AppError('MISSION_NOT_IN_PROGRESS', 400)
          }
          const lockedMission = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
          return reply.code(200).send(lockedMission)
        }
      }

      // Capture via le service (source unique) : pré-check escrow HELD + montant
      // `amount_to_capture` exact, contexte 'receive'.
      try {
        await captureEscrowFunds(mission.id, opts.stripe, 'receive')
      } catch (err) {
        if (err instanceof EscrowCaptureError) throw new AppError('ESCROW_NOT_HELD', 400)
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

      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.IN_PROGRESS },
          data: { status: MissionStatus.VALIDATED, saleSignature },
        })
        if (updated.count !== 1) throw new AppError('MISSION_NOT_IN_PROGRESS', 400)
      })

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
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)
      if (mission.status !== MissionStatus.ESCROW_LOCKED_CUSTOMS) {
        throw new AppError('MISSION_NOT_CUSTOMS_LOCKED', 400)
      }

      const { customsReceiptUrl, customsReceiptSha256 } = req.body as CustomsReceiptBody

      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.ESCROW_LOCKED_CUSTOMS },
          data: {
            status: MissionStatus.PENDING_CUSTOMS_REVIEW,
            customsReceiptUrl,
            customsReceiptSha256,
          },
        })
        if (updated.count !== 1) throw new AppError('MISSION_NOT_CUSTOMS_LOCKED', 400)
      })

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
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

      if (!DROPOFF_ALLOWED_STATUSES.includes(mission.status)) {
        throw new AppError('INVALID_MISSION_STATE', 400)
      }

      const { dropoffReceiptUrl, dropoffTrackingNumber } = req.body as DropoffReceiptBody

      // Sceau QR IDEMPOTENT : généré ici si /ship ne l'a pas posé, jamais écrasé.
      const newInnerQrCode = mission.innerQrCodeHash ? null : randomBytes(32).toString('hex')

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
        if (updated.count !== 1) throw new AppError('INVALID_MISSION_STATE', 400)
      })

      const deposited = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
      return reply
        .code(200)
        .send(newInnerQrCode ? { ...deposited, innerQrCode: newInnerQrCode } : deposited)
    },
  )

  // POST /api/missions/:id/confirm-collection — l'ACHETEUR confirme la collecte (capture + vérif QR).
  app.post(
    '/:id/confirm-collection',
    { schema: { params: missionIdParamsSchema, body: innerQrBodySchema } },
    async (req, reply) => {
      const { id } = req.params as { id: string }
      const mission = await findMissionForBuyer(prisma, id, req.user.sub)
      if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

      if (mission.status !== MissionStatus.DEPOSITED) {
        throw new AppError('INVALID_MISSION_STATE', 400)
      }

      // Sceau QR interne (anti « colis vide ») : vérification STRICTE en temps constant AVANT capture.
      verifyInnerSeal((req.body as InnerQrBody).innerQrCode, mission.innerQrCodeHash)

      // Capture via le service (source unique) : pré-check escrow HELD + montant
      // `amount_to_capture` exact, contexte 'collection' dédié au chemin collecte.
      try {
        await captureEscrowFunds(mission.id, opts.stripe, 'collection')
      } catch (err) {
        if (err instanceof EscrowCaptureError) throw new AppError('ESCROW_NOT_HELD', 400)
        throw err
      }

      await prisma.$transaction(async tx => {
        const updated = await tx.mission.updateMany({
          where: { id: mission.id, status: MissionStatus.DEPOSITED },
          data: { status: MissionStatus.VALIDATED },
        })
        if (updated.count !== 1) throw new AppError('INVALID_MISSION_STATE', 400)
      })

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

      await prisma.$transaction(async tx => {
        const mission = await findMissionForTraveler(tx, id, userId)
        if (!mission) throw new AppError('MISSION_NOT_FOUND', 404)

        if (mission.status !== MissionStatus.IN_PROGRESS) {
          throw new AppError('MISSION_NOT_IN_PROGRESS', 400)
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
        if (updated.count !== 1) throw new AppError('MISSION_NOT_IN_PROGRESS', 400)
      })

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
          if (!access) throw new AppError('MISSION_NOT_FOUND', 404)

          const { mission, relation } = access
          if (
            mission.status !== MissionStatus.RELEASED &&
            mission.status !== MissionStatus.CANCELLED
          ) {
            throw new AppError('MISSION_NOT_TERMINAL', 400)
          }

          let targetId: string
          if (relation === 'buyer') {
            if (!mission.travelerId) throw new AppError('NO_TRAVELER_ASSIGNED', 400)
            targetId = mission.travelerId
          } else {
            targetId = mission.buyerId
          }

          return tx.review.create({
            data: { missionId: id, authorId: userId, targetId, rating, comment },
          })
        })
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError('REVIEW_ALREADY_SUBMITTED', 409)
        throw err
      }

      return reply.code(201).send(review)
    },
  )
}
