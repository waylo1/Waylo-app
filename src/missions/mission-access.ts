import type { Mission, PrismaClient } from '../generated/prisma'

/**
 * Autorisation PAR RESSOURCE — fondation des droits Waylo. Aucune notion de
 * rôle de compte (cf. retrait de User.role) : « acheteur » / « voyageur » est
 * déterminé mission par mission, à partir de buyerId / travelerId.
 */

export type MissionRelation = 'buyer' | 'traveler'

export interface MissionAccess {
  mission: Mission
  relation: MissionRelation
}

/** Surface Prisma minimale — accepte le client réel comme une transaction. */
type MissionReader = Pick<PrismaClient['mission'], 'findUnique'>
type Db = { mission: MissionReader }

/**
 * Participant = acheteur OU voyageur assigné. Renvoie la mission + la relation,
 * ou `null` si la mission n'existe pas OU si l'utilisateur n'y participe pas.
 * Les deux cas sont VOLONTAIREMENT indistinguables côté appelant → 404, pour ne
 * pas révéler l'existence d'une mission à un tiers.
 */
export async function findMissionForParticipant(
  db: Db,
  missionId: string,
  userId: string,
): Promise<MissionAccess | null> {
  const mission = await db.mission.findUnique({ where: { id: missionId } })
  if (!mission) return null
  if (mission.buyerId === userId) return { mission, relation: 'buyer' }
  if (mission.travelerId === userId) return { mission, relation: 'traveler' }
  return null
}

/**
 * Acheteur seulement. `null` si la mission n'existe pas, ou si l'utilisateur en
 * est le voyageur ou un tiers. Base des actions réservées à l'acheteur
 * (ex. financement T0, validation T1).
 */
export async function findMissionForBuyer(
  db: Db,
  missionId: string,
  userId: string,
): Promise<Mission | null> {
  const access = await findMissionForParticipant(db, missionId, userId)
  return access?.relation === 'buyer' ? access.mission : null
}

/**
 * Voyageur assigné seulement. `null` si la mission n'existe pas, ou si
 * l'utilisateur en est l'acheteur ou un tiers. Base des actions réservées au
 * voyageur (ex. départ en mission, scellement des reçus).
 */
export async function findMissionForTraveler(
  db: Db,
  missionId: string,
  userId: string,
): Promise<Mission | null> {
  const access = await findMissionForParticipant(db, missionId, userId)
  return access?.relation === 'traveler' ? access.mission : null
}
