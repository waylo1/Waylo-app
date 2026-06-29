import { prisma } from '../db'
import { MissionStatus } from '../generated/prisma'

/**
 * userService — opérations de cycle de vie d'un compte utilisateur.
 *
 * `deleteAccount` porte une garde MÉTIER : un utilisateur impliqué (acheteur OU
 * voyageur) dans une mission EN VOL — c.-à-d. dont l'argent est en jeu (escrow
 * HELD, carte Issuing active, payout/refund en attente) — ne peut pas être
 * supprimé, sinon on perdrait une partie d'une transaction monétaire en cours.
 * La suppression n'est autorisée que pour les états pré-financement (CREATED,
 * NOTIFICATION_FAILED) et terminaux (RELEASED, REFUNDED, CANCELLED, EXPIRED).
 */

/**
 * États « en vol » : argent engagé ou en mouvement. Bloquent la suppression de
 * compte des deux parties. EXCLUS : CREATED / NOTIFICATION_FAILED (aucun escrow)
 * et les terminaux RELEASED / REFUNDED / CANCELLED / EXPIRED (transaction soldée).
 */
const IN_FLIGHT_STATUSES: MissionStatus[] = [
  MissionStatus.FUNDED,
  MissionStatus.MATCHED,
  MissionStatus.IN_PROGRESS,
  MissionStatus.ESCROW_LOCKED_CUSTOMS,
  MissionStatus.PENDING_CUSTOMS_REVIEW,
  MissionStatus.AWAITING_VALIDATION,
  MissionStatus.VALIDATED,
  MissionStatus.DEPOSITED,
  MissionStatus.DISPUTED,
  MissionStatus.IN_DISPUTE,
  MissionStatus.DISPUTED_FRAUD,
  MissionStatus.AWAITING_TRAVELER_ACCOUNT,
]

/** Suppression de compte refusée par une garde métier. */
export class AccountDeletionBlockedError extends Error {
  constructor(readonly code: 'MISSION_IN_FLIGHT') {
    super(code)
    this.name = 'AccountDeletionBlockedError'
  }
}

export async function deleteAccount(userId: string): Promise<void> {
  // Garde anti-suppression : aucune mission « en vol » impliquant l'utilisateur
  // (acheteur OU voyageur) — protège l'argent en transit.
  const blocking = await prisma.mission.findFirst({
    where: {
      status: { in: IN_FLIGHT_STATUSES },
      OR: [{ buyerId: userId }, { travelerId: userId }],
    },
    select: { id: true },
  })
  if (blocking) throw new AccountDeletionBlockedError('MISSION_IN_FLIGHT')

  await prisma.user.delete({ where: { id: userId } })
}
