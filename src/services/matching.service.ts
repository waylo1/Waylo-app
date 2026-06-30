import { MissionStatus } from '../generated/prisma'
import { prisma } from '../db'
import { AppError } from '../errors/app.error'

/**
 * matching.service — catalogue de matching GLOBAL « Net Gain ».
 *
 * Modèle métier : le voyageur est un OPÉRATEUR AUTONOME qui définit lui-même
 * son corridor. Waylo n'impose AUCUN filtrage géographique côté serveur — le
 * catalogue expose TOUTES les missions finançées (`FUNDED`), triées par
 * rentabilité décroissante pour le voyageur, et c'est au voyageur de filtrer
 * manuellement selon `origin`/`destination`.
 *
 * « Net Gain » = `commissionCents` (Frais Service). Le schéma ne porte pas de
 * champ `travelerReward` : la récompense du voyageur EST la commission figée de
 * la mission (`budgetCents + commissionCents` = total à la charge de l'acheteur).
 */

/** Plafond dur de page — borne la charge DB et la taille de réponse (anti-DoS). */
export const MATCH_PAGE_LIMIT_MAX = 100

/**
 * Avertissement de responsabilité opérationnelle injecté dans CHAQUE offre :
 * Waylo n'effectue ni filtrage géographique, ni contrôle douanier, ni
 * vérification de faisabilité du corridor. Le voyageur, opérateur autonome, est
 * seul responsable de la légalité et de la faisabilité du transport accepté.
 */
export const MATCHING_OPERATIONAL_DISCLAIMER =
  "Waylo n'effectue aucun filtrage géographique ni contrôle de faisabilité du corridor. " +
  'Le voyageur, opérateur autonome, est seul responsable de la légalité, des obligations ' +
  "douanières et de la faisabilité du transport qu'il choisit d'accepter."

/**
 * Offre présentée au voyageur dans le catalogue global. Montants en centimes Int.
 * `origin`/`destination` = endpoints du corridor (texte saisi à la création) pour
 * le filtrage MANUEL du voyageur ; `destinationCountryIso` = code pays ISO-2
 * destination (null si non renseigné — pas de seuil douanier déclaré).
 */
export interface TravelerMatchOffer {
  missionId: string
  targetProduct: string
  budgetCents: number
  /** « Net Gain » voyageur = `commissionCents` (Frais Service figé). */
  travelerRewardCents: number
  origin: string
  destination: string
  destinationCountryIso: string | null
  createdAt: Date
  operationalDisclaimer: string
}

/** Page de catalogue. `hasMore` est calculé sans `COUNT(*)` (lecture de limit + 1). */
export interface PaginatedMatches {
  offers: TravelerMatchOffer[]
  page: number
  limit: number
  hasMore: boolean
}

/** Vrai ssi `value` est un entier (number) compris dans [min, max] inclus. */
function isIntInRange(value: number, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/**
 * Catalogue paginé des missions disponibles pour un voyageur, trié « Net Gain ».
 *
 * Filtrage : `status === FUNDED` UNIQUEMENT (aucun filtre géographique serveur).
 * Tri : `commissionCents` desc (rentabilité) puis `createdAt` desc (récence) —
 * servi par l'index `idx_net_gain_matching` (parcours déjà ordonné).
 *
 * @throws {AppError} `INVALID_PAGINATION` (400) si `page`/`limit` ne sont pas des
 *   entiers valides ou hors borne (validation STRICTE, aucune coercition).
 */
export async function getAvailableMatches(
  page: number,
  limit: number,
): Promise<PaginatedMatches> {
  if (!isIntInRange(page, 1, Number.MAX_SAFE_INTEGER)) {
    throw new AppError('INVALID_PAGINATION', 400, { field: 'page', min: 1 })
  }
  if (!isIntInRange(limit, 1, MATCH_PAGE_LIMIT_MAX)) {
    throw new AppError('INVALID_PAGINATION', 400, { field: 'limit', min: 1, max: MATCH_PAGE_LIMIT_MAX })
  }

  const skip = (page - 1) * limit
  // page très élevé : l'offset dépasse l'entier sûr ⇒ rejet plutôt que résultat faux.
  if (!Number.isSafeInteger(skip)) {
    throw new AppError('INVALID_PAGINATION', 400, { field: 'page' })
  }

  // take = limit + 1 : une ligne sentinelle décide `hasMore` sans COUNT(*) séparé.
  const rows = await prisma.mission.findMany({
    where: { status: MissionStatus.FUNDED },
    orderBy: [{ commissionCents: 'desc' }, { createdAt: 'desc' }],
    skip,
    take: limit + 1,
    select: {
      id: true,
      targetProduct: true,
      budgetCents: true,
      commissionCents: true,
      origin: true,
      destination: true,
      destinationCountry: true,
      createdAt: true,
    },
  })

  const hasMore = rows.length > limit
  const pageRows = hasMore ? rows.slice(0, limit) : rows

  const offers: TravelerMatchOffer[] = pageRows.map((m) => ({
    missionId: m.id,
    targetProduct: m.targetProduct,
    budgetCents: m.budgetCents,
    travelerRewardCents: m.commissionCents,
    origin: m.origin,
    destination: m.destination,
    destinationCountryIso: m.destinationCountry,
    createdAt: m.createdAt,
    operationalDisclaimer: MATCHING_OPERATIONAL_DISCLAIMER,
  }))

  return { offers, page, limit, hasMore }
}
