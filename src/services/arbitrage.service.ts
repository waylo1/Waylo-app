import { prisma } from '../db'
import { DeliveryProofStatus } from '../generated/prisma'
import type { Mission } from '../generated/prisma'

/**
 * ArbitrageService — arbitrage HUMAIN de la preuve de livraison.
 *
 * `updateDeliveryProof(missionId, adminId, status)` pose `Mission.deliveryProofStatus`
 * (VALIDATED | REJECTED) sur décision d'un opérateur ops/admin et trace l'acteur dans
 * `AdminAuditLog` (actor=ADMIN, adminId renseigné). C'est CETTE décision qui rend une
 * contestation facturable : `deliveryProofStatus === VALIDATED` est la source de vérité
 * lue par `disputeResolutionWorker` (verifyAbuse) pour créer la pénalité d'instruction.
 *
 * SÛRETÉ :
 * - Atomique : update + audit dans une seule `prisma.$transaction` — aucun side-effect
 *   hors transaction (aucun appel réseau, règle d'or trivialement respectée).
 * - Fail-closed : `updateMany` conditionnel sur l'id ; `count !== 1` (mission absente)
 *   ⇒ `MISSION_NOT_FOUND` → 404 côté route (aucune écriture, audit jamais créé).
 * - Traçabilité d'acteur : `actor: 'ADMIN'` + `adminId` posés explicitement — le
 *   discriminant `AuditActor` distingue cette décision humaine des entrées SYSTÈME.
 */

export class ArbitrageError extends Error {
  constructor(readonly code: 'MISSION_NOT_FOUND') {
    super(code)
    this.name = 'ArbitrageError'
  }
}

/**
 * Pose `deliveryProofStatus` + trace l'arbitrage, ATOMIQUEMENT. Renvoie la mission à jour.
 * `status` est restreint à VALIDATED | REJECTED par l'Ajv de la route (PENDING = défaut
 * initial, jamais une issue d'arbitrage).
 */
export async function updateDeliveryProof(
  missionId: string,
  adminId: string,
  status: DeliveryProofStatus,
): Promise<Mission> {
  return prisma.$transaction(async tx => {
    // Transition inconditionnelle sur l'id (le champ est orthogonal au MissionStatus) ;
    // `count !== 1` = mission absente → fail-closed avant toute écriture d'audit.
    const updated = await tx.mission.updateMany({
      where: { id: missionId },
      data: { deliveryProofStatus: status },
    })
    if (updated.count !== 1) throw new ArbitrageError('MISSION_NOT_FOUND')

    await tx.adminAuditLog.create({
      data: {
        actor: 'ADMIN', // décision humaine — discriminant stable (cf. AuditActor)
        adminId,
        action: 'MISSION_DELIVERY_PROOF_UPDATED',
        missionId,
      },
    })

    return tx.mission.findUniqueOrThrow({ where: { id: missionId } })
  })
}
