// DTOs partagés backend ↔ mobile — projections SÛRES des modèles Prisma.
//
// Conventions :
// - Argent : centimes (Int), jamais de Float (cf. CLAUDE.md / rules.md §3).
// - Dates : chaînes ISO 8601 — c'est le format JSON sur le fil (Date sérialisée).
//   Les modèles Prisma utilisent `DateTime`, mais le client mobile reçoit du JSON.
// - Aucun secret n'est exposé : ni passwordHash, ni identifiants Stripe.

import type { KycStatus, MissionStatus, DeliveryProofStatus } from './prisma-enums'
import type { TokenClaims } from './auth'

/**
 * Vue publique d'un utilisateur — projection de GET /api/auth/me
 * (`select: { id, email, kycStatus, createdAt }`). N'expose JAMAIS passwordHash
 * ni les identifiants Stripe (customer/account/paymentMethod).
 */
export interface UserDTO {
  id: string
  email: string
  kycStatus: KycStatus
  /** ISO 8601 (format JSON de `User.createdAt`). */
  createdAt: string
}

/**
 * Vue client d'une mission — sous-ensemble sûr du modèle Mission.
 * `travelerId` est null tant que la mission n'est pas appariée (MATCHED).
 */
export interface MissionDTO {
  id: string
  buyerId: string
  travelerId: string | null
  status: MissionStatus
  targetProduct: string
  /** Centimes (Int) — figé après MATCHED. */
  budgetCents: number
  /** Centimes (Int) — figé. */
  commissionCents: number
  origin: string
  destination: string
  /** Pré-autorisation acheteur du modèle « Drive » (reçu jusqu'à 120% du budget). */
  substitutionAuthorized: boolean
  deliveryProofStatus: DeliveryProofStatus
  /** ISO 8601 (format JSON de `Mission.expiresAt`). */
  expiresAt: string
  /** ISO 8601 (format JSON de `Mission.createdAt`). */
  createdAt: string
  /** ISO 8601 (format JSON de `Mission.updatedAt`). */
  updatedAt: string
}

/**
 * Session authentifiée côté client (mobile). Pas de modèle Prisma : agrège le JWT
 * (LoginResponse), ses claims décodés et l'utilisateur courant (GET /api/auth/me).
 */
export interface SessionDTO {
  token: string
  claims: TokenClaims
  user: UserDTO
}
