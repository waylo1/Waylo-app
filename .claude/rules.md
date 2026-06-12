# Règles strictes — NE JAMAIS DÉROGER

## 1. Zéro chat
- Aucune messagerie libre client ↔ runner, ni in-app ni externe.
- Toute interaction passe par des **choix structurés** (boutons, listes de substitution,
  validations oui/non) modélisés en DB avec enums Prisma.
- Ne jamais implémenter de champ texte libre dans un flux de mission. Si un besoin de
  communication apparaît, le résoudre par un nouvel état/enum, pas par du chat.

## 2. Validation humaine obligatoire
- Aucun argent capturé ou versé, aucune substitution acceptée sans action explicite
  de l'utilisateur (`USER_VALIDATED` ou équivalent).
- L'IA propose, l'humain dispose. Jamais d'auto-accept, même avec timeout.
- Timeout d'une validation = annulation/remboursement, jamais acceptation implicite.

## 3. Finance
- Centimes `Int` partout. Jamais Float pour l'argent.
- Capture du PaymentIntent APRÈS validation humaine de l'acheteur, jamais à
  l'autorisation (l'autorisation pose HELD, la capture déclenche RELEASED).
- Remboursement automatique sur tout état `*_FAILED`.
- Stripe Issuing : **Option B JIT uniquement** — pas de pré-financement carte,
  décision d'autorisation en temps réel contre l'escrow `HELD` et son plafond de
  mission figé (`spendingLimitCents`).
- Webhooks Stripe : `constructEvent()` avec vérification signature, même en dev.

## 4. Données
- PostgreSQL + Prisma exclusivement. Pas de SQLite (enums non supportés).
- Tout débit wallet dans `prisma.$transaction()` avec lecture verrouillée (anti-TOCTOU).
- `failureReason` toujours renseigné sur les états d'échec.
- Reçus : scellés par sha256 + horodatage, immuables après scellement (cf. workflows).

## 5. Code
- TypeScript strict, zéro `any`.
- Inférence IA on-device uniquement, jamais cloud.
- Packages internes : builder (`tsc -b`) avant exécution — main/types pointent vers `dist/`.
