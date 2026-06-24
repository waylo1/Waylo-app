// @waylo/shared — SSOT (Single Source of Truth) des types partagés backend ↔ mobile.
//
// Règle d'or : ZÉRO dépendance runtime. Ce paquet n'exporte QUE des types
// (interfaces, alias, ré-exports `export type`). Tout est effacé à la compilation,
// donc rien n'atterrit dans le bundle React Native ni dans le runtime Node.
//
// Consommé depuis les sources (package.json main/types/exports → src/index.ts) :
// pas d'étape de build, le backend (tsx/tsc) et le mobile (Metro/tsc) compilent
// directement le TypeScript de ce paquet.

// Enums dérivés du client Prisma généré (aucune redéclaration — voir prisma-enums.ts).
export type {
  MissionStatus,
  DeliveryProofStatus,
  PenaltyReason,
  KycStatus,
} from './prisma-enums'

// Payloads d'authentification.
export type { LoginRequest, LoginResponse, TokenClaims } from './auth'

// DTOs (projections sûres des modèles Prisma).
export type { UserDTO, MissionDTO, SessionDTO } from './dto'
