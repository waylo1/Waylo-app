import type { Mission } from '../../generated/prisma'

/**
 * Whitelist de sérialisation publique d'une mission (privacy-first).
 * Seule source de vérité de ce qui sort vers le client : tout champ absent
 * de cette interface est inexistant côté réponse, même ajouté plus tard au
 * modèle Prisma. Types projetés depuis `Mission` → restent synchronisés et
 * la suppression d'un champ whitelisté casse la compilation.
 */
export interface PublicMissionDTO {
  id: Mission['id']
  status: Mission['status']
  buyerId: Mission['buyerId']
  travelerId: Mission['travelerId']
  budgetCents: Mission['budgetCents']
  commissionCents: Mission['commissionCents']
  createdAt: Mission['createdAt']
}

/**
 * Projection pure (O(1), sans I/O ni accès DB) d'une `Mission` vers son DTO
 * public, par énumération explicite des clés autorisées. Entrée typée sur
 * `Mission` : retirer un champ whitelisté casse la compilation (fail au
 * build, pas au runtime). Aucune construction par soustraction.
 */
export function mapToPublicMissionDTO(mission: Mission): PublicMissionDTO {
  return {
    id: mission.id,
    status: mission.status,
    buyerId: mission.buyerId,
    travelerId: mission.travelerId,
    budgetCents: mission.budgetCents,
    commissionCents: mission.commissionCents,
    createdAt: mission.createdAt,
  }
}
