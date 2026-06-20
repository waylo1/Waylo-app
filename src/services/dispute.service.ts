import { prisma } from '../db'
import { Dispute, DisputeStatus, PrismaClient } from '../generated/prisma'
import { findMissionForBuyer, findMissionForParticipant } from '../missions/mission-access'
import { isRequestAdmin, isUniqueViolation } from '../missions/mission-common'

// Surface minimale acceptée par les variantes tx-aware (compatible PrismaClient et client transaction).
type DisputeWriter = Pick<PrismaClient['dispute'], 'upsert' | 'updateMany'>

/**
 * DisputeService — cycle de vie immuable du litige (DRAFT → OPEN → ESCALATED →
 * RESOLVED → CLOSED), miroir des garde-fous EscrowTransaction.
 *
 * SÛRETÉ :
 * - Idempotence : création via `idempotencyKey` @unique (un litige par mission) ;
 *   chaque transition est conditionnelle (`where: { status: FROM }`) → un rejeu
 *   sur l'état cible est un no-op (renvoie l'état courant), jamais une double écriture.
 * - Anti-TOCTOU : transition atomique `updateMany` ; `count !== 1` + état ≠ cible
 *   ⇒ DISPUTE_INVALID_STATE (409). Aucun chemin ne mute un litige CLOSED.
 * - OWASP A01 : autorisation PAR RESSOURCE. Ouverture/escalade réservées à
 *   l'acheteur (ou participant) — 404 masquant pour un tiers. Résolution/clôture
 *   réservées à l'admin (403). Erreurs typées en SNAKE_CASE.
 */

const MAX_TEXT = 2000

export class DisputeError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'DisputeError'
  }
}

/** Acheteur de la mission, sinon 404 masquant (anti-IDOR). */
async function assertBuyer(missionId: string, actorId: string): Promise<void> {
  const mission = await findMissionForBuyer(prisma, missionId, actorId)
  if (!mission) throw new DisputeError('MISSION_NOT_FOUND')
}

/** Participant (acheteur OU voyageur), sinon 404 masquant. */
async function assertParticipant(missionId: string, actorId: string): Promise<void> {
  const access = await findMissionForParticipant(prisma, missionId, actorId)
  if (!access) throw new DisputeError('MISSION_NOT_FOUND')
}

async function assertAdmin(actorId: string): Promise<void> {
  if (!(await isRequestAdmin(actorId))) throw new DisputeError('FORBIDDEN')
}

function sanitizeText(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new DisputeError(code)
  return value
}

async function getOrThrow(missionId: string): Promise<Dispute> {
  const dispute = await prisma.dispute.findUnique({ where: { missionId } })
  if (!dispute) throw new DisputeError('DISPUTE_NOT_FOUND')
  return dispute
}

/**
 * Transition conditionnelle atomique. Idempotente : si le litige est déjà dans
 * l'état cible, no-op (renvoie l'état courant). Sinon, état source invalide → 409.
 */
async function transition(
  missionId: string,
  from: DisputeStatus,
  to: DisputeStatus,
  stamp: Partial<Record<'openedAt' | 'escalatedAt' | 'resolvedAt' | 'closedAt', Date>>,
  extra: { resolution?: string } = {},
): Promise<Dispute> {
  const res = await prisma.dispute.updateMany({
    where: { missionId, status: from },
    data: { status: to, ...stamp, ...extra },
  })
  if (res.count !== 1) {
    const current = await getOrThrow(missionId)
    if (current.status === to) return current // rejeu idempotent
    throw new DisputeError('DISPUTE_INVALID_STATE')
  }
  return getOrThrow(missionId)
}

/** DRAFT — l'acheteur initie un litige. Idempotent (un litige par mission). */
export async function createDispute(input: {
  missionId: string
  actorId: string
  reason?: string
}): Promise<Dispute> {
  await assertBuyer(input.missionId, input.actorId)
  const reason = sanitizeText(input.reason, 'INVALID_REASON')
  try {
    return await prisma.dispute.create({
      data: {
        missionId: input.missionId,
        openedById: input.actorId,
        reason: reason ?? null,
        idempotencyKey: `dispute_${input.missionId}`,
      },
    })
  } catch (err) {
    if (isUniqueViolation(err)) return getOrThrow(input.missionId) // déjà créé : idempotent
    throw err
  }
}

/** DRAFT → OPEN — l'acheteur ouvre formellement le litige. */
export async function openDispute(input: { missionId: string; actorId: string }): Promise<Dispute> {
  await assertBuyer(input.missionId, input.actorId)
  return transition(input.missionId, DisputeStatus.DRAFT, DisputeStatus.OPEN, { openedAt: new Date() })
}

/** OPEN → ESCALATED — un participant escalade vers l'arbitrage humain. */
export async function escalateDispute(input: {
  missionId: string
  actorId: string
}): Promise<Dispute> {
  await assertParticipant(input.missionId, input.actorId)
  return transition(input.missionId, DisputeStatus.OPEN, DisputeStatus.ESCALATED, {
    escalatedAt: new Date(),
  })
}

/** OPEN | ESCALATED → RESOLVED — décision admin. */
export async function resolveDispute(input: {
  missionId: string
  actorId: string
  resolution?: string
}): Promise<Dispute> {
  await assertAdmin(input.actorId)
  const resolution = sanitizeText(input.resolution, 'INVALID_RESOLUTION')
  const current = await getOrThrow(input.missionId)
  if (current.status === DisputeStatus.RESOLVED) return current // idempotent
  if (current.status !== DisputeStatus.OPEN && current.status !== DisputeStatus.ESCALATED) {
    throw new DisputeError('DISPUTE_INVALID_STATE')
  }
  return transition(input.missionId, current.status, DisputeStatus.RESOLVED, { resolvedAt: new Date() }, {
    ...(resolution !== undefined ? { resolution } : {}),
  })
}

/** RESOLVED → CLOSED — clôture admin (terminal, immuable). */
export async function closeDispute(input: { missionId: string; actorId: string }): Promise<Dispute> {
  await assertAdmin(input.actorId)
  return transition(input.missionId, DisputeStatus.RESOLVED, DisputeStatus.CLOSED, {
    closedAt: new Date(),
  })
}

/** Lecture — réservée aux participants (404 masquant). */
export async function getDispute(input: {
  missionId: string
  actorId: string
}): Promise<Dispute> {
  await assertParticipant(input.missionId, input.actorId)
  return getOrThrow(input.missionId)
}

/**
 * Variantes TX-AWARE — à appeler UNIQUEMENT dans un `prisma.$transaction()`.
 * Pas de vérification d'accès (faite en amont par la route), pas de catch
 * de violation d'unicité (géré par le rollback de la transaction parente).
 *
 * Pattern identique à `mission-access.ts` : acceptent un objet structurellement
 * compatible avec `PrismaClient` (transaction client ou client de base).
 */

/** Crée le litige (DRAFT) en mode idempotent via upsert — safe dans une tx. */
export async function createDisputeInTx(
  client: { dispute: DisputeWriter },
  missionId: string,
  actorId: string,
  reason?: string | null,
): Promise<void> {
  await client.dispute.upsert({
    where: { missionId },
    create: {
      missionId,
      openedById: actorId,
      reason: reason ?? null,
      idempotencyKey: `dispute_${missionId}`,
    },
    update: {},
  })
}

/** Fait passer le litige DRAFT → OPEN (transition conditionnelle atomique). */
export async function openDisputeInTx(
  client: { dispute: DisputeWriter },
  missionId: string,
): Promise<void> {
  await client.dispute.updateMany({
    where: { missionId, status: DisputeStatus.DRAFT },
    data: { status: DisputeStatus.OPEN, openedAt: new Date() },
  })
}
