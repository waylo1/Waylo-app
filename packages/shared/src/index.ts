// @waylo/shared — SSOT (Single Source of Truth) des types partagés backend ↔ mobile.
//
// Règle d'or : ZÉRO dépendance runtime. Ce paquet n'exporte QUE des types
// (interfaces, alias, ré-exports `export type`). Tout est effacé à la compilation,
// donc rien n'atterrit dans le bundle React Native ni dans le runtime Node.
//
// Le contenu réel (enums dérivés de Prisma, DTOs, payloads d'auth) est ajouté en
// TASK-MOB-01. MOB-00 ne pose que le squelette du paquet.
export {}
