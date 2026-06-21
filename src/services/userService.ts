import { prisma } from '../db'
import { MissionStatus } from '../generated/prisma'

/**
 * userService — opérations de cycle de vie d'un compte utilisateur.
 *
 * `deleteAccount` porte une garde MÉTIER : un utilisateur impliqué (acheteur OU
 * voyageur) dans une mission EN ATTENTE DE CONFIRMATION DE RÉCEPTION
 * (`AWAITING_CONFIRMATION`) ne peut pas être supprimé — sinon on perdrait une
 * partie d'une transaction monétaire en cours (preuve de livraison non encore
 * confirmée, paiement voyageur non encore déclenché). La suppression est refusée
 * tant que la mission n'a pas quitté cet état.
 */

/** Suppression de compte refusée par une garde métier. */
export class AccountDeletionBlockedError extends Error {
  constructor(readonly code: 'MISSION_AWAITING_CONFIRMATION') {
    super(code)
    this.name = 'AccountDeletionBlockedError'
  }
}

export async function deleteAccount(userId: string): Promise<void> {
  // Garde anti-suppression : aucune mission AWAITING_CONFIRMATION impliquant l'utilisateur.
  const blocking = await prisma.mission.findFirst({
    where: {
      status: MissionStatus.AWAITING_CONFIRMATION,
      OR: [{ buyerId: userId }, { travelerId: userId }],
    },
    select: { id: true },
  })
  if (blocking) throw new AccountDeletionBlockedError('MISSION_AWAITING_CONFIRMATION')

  await prisma.user.delete({ where: { id: userId } })
}
