// Enums dérivés du client Prisma généré — SSOT unique, AUCUNE redéclaration.
//
// `export type { ... }` est un ré-export PUREMENT typescriptuel : il est effacé à
// la compilation (zéro code émis), donc aucune dépendance runtime n'est introduite
// — ni dans le bundle React Native, ni dans le runtime Node. Le type obtenu EST
// l'union littérale générée par Prisma : tout drift avec schema.prisma est
// structurellement impossible (on ne copie rien, on ré-exporte la source).
//
// Chemin : depuis packages/shared/src/ on remonte à la racine du dépôt, où le
// schéma écrit son client (`generator client { output = "../src/generated/prisma" }`).
// Prérequis : `prisma generate` doit avoir tourné — garanti par le postinstall
// racine (`npm install` → `prisma generate`).
export type {
  MissionStatus,
  DeliveryProofStatus,
  PenaltyReason,
  KycStatus,
} from '../../../src/generated/prisma'
