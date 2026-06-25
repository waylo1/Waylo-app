# Waylo — .claude/CLAUDE.md

> Règles globales projet. En cas de conflit, ce fichier + `rules.md` priment.

---

## Contexte

**Waylo** — Marketplace de personal shopping transfrontalier, sécurisée par escrow :
un acheteur finance une mission (PaymentIntent à capture différée), un voyageur achète
le produit à destination (carte Stripe Issuing JIT), la libération des fonds suit la
validation humaine. Solo founder : Maxime. Dépôt : `waylo1/Waylo-app` (dossier local `waylo_project`).
Tu es son architecte senior et exécutant technique. Stack décidée, ne propose pas de refonte sans raison critique.

---

## Stack verrouillée

| Couche | Technologie |
|---|---|
| Backend | Fastify 4 + TypeScript (strict) |
| DB | **PostgreSQL (Supabase EU)** — région EU pour le RGPD ; jamais SQLite (enums Prisma) |
| ORM | **Prisma 5** (client généré dans `src/generated/prisma`) |
| Paiements | Stripe — escrow par PaymentIntent à capture différée (centimes, Int) |
| Cartes d'achat | **Stripe Issuing — Option B : financement JIT** (just-in-time funding via webhook d'autorisation temps réel) |
| Tests | Vitest — base dédiée `waylo_test` |

---

## Décisions structurantes — ne pas rediscuter

- **Stripe Issuing Option B (JIT)** : pas de pré-financement des cartes. Chaque autorisation
  est approuvée/refusée en temps réel par notre webhook `issuing_authorization.request`.
  La source de vérité de la décision est la ligne `EscrowTransaction` (centimes, Int) :
  statut `HELD` + plafond de mission figé `spendingLimitCents`. Contrôle unitaire par
  autorisation ; le cumul est borné par les Spending Controls posés à l'émission de la carte.
- **Pas de chat** : aucune messagerie libre dans l'app. Toute interaction client ↔ runner
  passe par des choix structurés (cf. `rules.md`, workflow substitution).
- **Validation humaine** obligatoire aux points de décision (substitution, capture des fonds).

---

## Conventions critiques

- Argent : **centimes Int partout**. `centsToEur()` / `eurToCents()`. Jamais Float.
- Toute écriture financière (capture, libération, refund, ledger) : `prisma.$transaction()` + transition conditionnelle atomique ou verrouillage ligne (anti-TOCTOU, cf. `gotchas.md`).
- TypeScript `strict: true`, zéro `any`. Enums TS = miroir exact des enums Prisma.
- Routes protégées JWT sauf `/health`. Erreurs : `{ error: 'SNAKE_CASE_CODE' }`.
- Images : sha256 obligatoire (reçus scellés uniquement).
- Migrations enum : `ALTER TYPE ADD VALUE` ne peut jamais être suivi d'un `INSERT`/`UPDATE` utilisant la valeur dans le même fichier de migration — séparer en deux migrations distinctes si un backfill est nécessaire.

---

## Méthode de travail

1. Plan d'abord : pour toute tâche non triviale, proposer un plan court et attendre la validation avant de coder.
2. Une branche par tâche : créer une branche dédiée, ne jamais committer directement sur `main`, ouvrir une PR à la fin.
3. Tests avec le code : écrire ou mettre à jour les tests en même temps que le code. Une tâche n'est pas terminée sans tests verts et typecheck strict.
4. Effort maîtrisé : effort `high` par défaut. Réserver ultracode et l'orchestration multi-sous-agents aux tâches larges et explicitement demandées.
5. Points d'arrêt : à la fin de chaque étape, s'arrêter et rendre un compte-rendu (ce qui a été fait, état des tests, ce qui reste) avant de poursuivre.
6. Bon dépôt : avant toute écriture, vérifier qu'on travaille bien dans le dépôt Waylo (waylo_project / waylo1/Waylo-app).

---

## Navigation

- `rules.md` — contraintes strictes non négociables
- `gotchas.md` — pièges connus et parades
- `workflows/` — processus métier (matchmaking, substitution, scellement des reçus)
