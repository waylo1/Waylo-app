import { FastifyRequest, FastifyReply } from 'fastify'
import { Prisma } from '../generated/prisma'
import { isRateLimited, maskIp } from '../rate-limit'
import type { AlertSink } from '../alerts'

export async function isRequestAdmin(userId: string): Promise<boolean> {
  const { prisma } = await import('../db')
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { isAdmin: true },
  })
  return user?.isAdmin === true
}

export async function travelerHasGuaranteeCard(userId: string): Promise<boolean> {
  const { prisma } = await import('../db')
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripePaymentMethodId: true },
  })
  return Boolean(user?.stripePaymentMethodId)
}

export const rateLimit =
  (name: string) => async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (await isRateLimited(`${name}:${maskIp(req.ip)}:${req.user.sub}`)) {
      await reply.code(429).send({ error: 'RATE_LIMITED' })
    }
  }

export const substitutionCeilingCents = (budgetCents: number): number =>
  Math.floor((budgetCents * 12) / 10)

export async function checkFundingCapacity(
  missionId: string,
  budgetCents: number,
  commissionCents: number,
  declaredAuthCents: number | undefined,
): Promise<{ status: number; code: string } | null> {
  const {
    validateMissionFunding,
    requiredCapacityCents,
    CheckoutValidationError,
  } = await import('../checkout/wallet-validation')

  const stripeAuthorizationCents =
    declaredAuthCents ?? requiredCapacityCents(budgetCents + commissionCents)
  try {
    await validateMissionFunding({ missionId, stripeAuthorizationCents })
    return null
  } catch (err) {
    if (err instanceof CheckoutValidationError) {
      return { status: err.code === 'MISSION_NOT_FOUND' ? 404 : 400, code: err.code }
    }
    throw err
  }
}

export const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

// Interfaces
export interface PaymentIntentClient {
  paymentIntents: {
    create(
      params: {
        amount: number
        currency: string
        capture_method: 'manual'
        metadata: Record<string, string>
      },
      options: { idempotencyKey: string },
    ): Promise<{ id: string; client_secret: string | null }>
    capture(
      id: string,
      params: { amount_to_capture?: number },
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
    cancel?(
      id: string,
      params: Record<string, never>,
      options: { idempotencyKey: string },
    ): Promise<{ id: string }>
  }
  checkout?: {
    sessions: {
      create(
        params: {
          mode: 'payment'
          line_items: Array<{
            price_data: {
              currency: string
              product_data: { name: string }
              unit_amount: number
            }
            quantity: number
          }>
          payment_intent_data: { capture_method: 'manual'; metadata: Record<string, string> }
          success_url: string
          cancel_url: string
          metadata: Record<string, string>
        },
        options: { idempotencyKey: string },
      ): Promise<{ id: string; url: string | null; payment_intent: string | { id: string } | null }>
    }
  }
}

export interface MissionRouteOptions {
  stripe: PaymentIntentClient
  onAlert?: AlertSink
}

// Type bodies
export interface CreateMissionBody {
  targetProduct: string
  budgetCents: number
  commissionCents: number
  origin: string
  destination: string
  destinationCountry: string
  expiresAt: string
  substitutionAuthorized?: boolean
}

export interface FundingBody {
  stripeAuthorizationCents?: number
}

export interface DropOffBody {
  dropOffType: string
  dropOffCarrier: string
  dropOffTrackingId: string
  dropOffAccessCode?: string
}

export interface CustomsReceiptBody {
  customsReceiptUrl: string
  customsReceiptSha256: string
}

export interface SubmitReceiptBody {
  urlRecu: string
  purchaseAmountCents: number
}

export interface DropoffReceiptBody {
  dropoffReceiptUrl: string
  dropoffTrackingNumber?: string
}

export interface DisputeBody {
  disputeReason?: string
}

export interface ShipBody {
  trackingReference: string
  purchaseAmountCents: number
}

export interface ReviewBody {
  rating: number
  comment?: string
}

// Schemas
export const createMissionBodySchema = {
  type: 'object',
  required: [
    'targetProduct',
    'budgetCents',
    'commissionCents',
    'origin',
    'destination',
    'destinationCountry',
    'expiresAt',
  ],
  additionalProperties: false,
  properties: {
    targetProduct: { type: 'string', minLength: 1, maxLength: 500 },
    budgetCents: { type: 'integer', minimum: 1 },
    commissionCents: { type: 'integer', minimum: 0 },
    origin: { type: 'string', minLength: 1, maxLength: 200 },
    destination: { type: 'string', minLength: 1, maxLength: 200 },
    destinationCountry: { type: 'string', pattern: '^[A-Za-z]{2}$' },
    expiresAt: { type: 'string', minLength: 1 },
    substitutionAuthorized: { type: 'boolean' },
  },
} as const

export const missionIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
} as const

export const availableQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    origin: { type: 'string', maxLength: 200 },
    destination: { type: 'string', maxLength: 200 },
  },
} as const

export const dropOffBodySchema = {
  type: 'object',
  required: ['dropOffType', 'dropOffCarrier', 'dropOffTrackingId'],
  additionalProperties: false,
  properties: {
    dropOffType: { type: 'string', enum: ['LOCKER', 'RELAY', 'POSTAL'] },
    dropOffCarrier: { type: 'string', minLength: 1, maxLength: 200 },
    dropOffTrackingId: { type: 'string', minLength: 1, maxLength: 200 },
    dropOffAccessCode: { type: 'string', minLength: 1, maxLength: 100 },
  },
} as const

export const customsReceiptBodySchema = {
  type: 'object',
  required: ['customsReceiptUrl', 'customsReceiptSha256'],
  additionalProperties: false,
  properties: {
    customsReceiptUrl: {
      type: 'string',
      minLength: 1,
      maxLength: 2048,
      pattern: '^https?://.+\\.([pP][dD][fF]|[pP][nN][gG]|[jJ][pP][eE]?[gG]|[wW][eE][bB][pP])(\\?.*)?$',
    },
    customsReceiptSha256: {
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    },
  },
} as const

export const shipBodySchema = {
  type: 'object',
  required: ['trackingReference', 'purchaseAmountCents'],
  additionalProperties: false,
  properties: {
    trackingReference: { type: 'string', minLength: 1, maxLength: 200 },
    purchaseAmountCents: { type: 'integer', minimum: 1 },
  },
} as const

export const submitReceiptBodySchema = {
  type: 'object',
  required: ['urlRecu', 'purchaseAmountCents'],
  additionalProperties: false,
  properties: {
    urlRecu: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://.+' },
    purchaseAmountCents: { type: 'integer', minimum: 1 },
  },
} as const

export const dropoffReceiptBodySchema = {
  type: 'object',
  required: ['dropoffReceiptUrl'],
  additionalProperties: false,
  properties: {
    dropoffReceiptUrl: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^https?://.+' },
    dropoffTrackingNumber: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const

export const disputeBodySchema = {
  type: 'object',
  required: [],
  additionalProperties: false,
  properties: {
    disputeReason: { type: 'string', minLength: 1, maxLength: 2000 },
  },
} as const

export const reviewBodySchema = {
  type: 'object',
  required: ['rating'],
  additionalProperties: false,
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string', minLength: 1, maxLength: 2000 },
  },
} as const

// Error classes
export class ValidationConflictError extends Error {}
export class ConfirmReceiptConflictError extends Error {}
export class MatchConflictError extends Error {}
export class ReceiptConflictError extends Error {}
export class ReceiveConflictError extends Error {}
export class CustomsConflictError extends Error {}
export class CustomsReviewConflictError extends Error {}
export class DropoffConflictError extends Error {}
export class CollectionConflictError extends Error {}
export class DisputeConflictError extends Error {}
export class ResolveRefundConflictError extends Error {}
export class ResolvePayoutConflictError extends Error {}
export class LogisticsDropOffNotFoundError extends Error {}
export class LogisticsDropOffStatusError extends Error {}
export class LogisticsDropOffConflictError extends Error {}
export class ReviewNotFoundError extends Error {}
export class ReviewNotTerminalError extends Error {}
export class ReviewNoTravelerError extends Error {}
