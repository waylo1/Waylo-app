---
name: audit-security
description: "Audit/revue de sécurité d'un flux Waylo DÉJÀ ÉCRIT côté admin ou worker : qui peut modifier deliveryProofStatus (admin seul, VALIDATED|REJECTED), isolation append-only de AdminAuditLog (discriminant ADMIN vs SYSTEM, pas de fuite cross-mission), déduplication des workers outbox (DisputeResolutionWorker, penalty-worker — FOR UPDATE SKIP LOCKED, NOT EXISTS, upsert no-op) et robustesse au crash des outbox de pénalité. Produit une checklist de verdicts. NE PAS utiliser pour écrire une nouvelle transition financière (→ anti-toctou-idempotency) ni pour la validation de reçus (→ receipt-module)."
---

# Audit sécurité — flux admin & workers Waylo

Procédure de **revue** (read-mostly) d'un flux déjà écrit touchant l'arbitrage admin, le
journal d'audit ou un worker outbox. Produit une **checklist de verdicts** (✅ conforme /
❌ écart `fichier:ligne` + risque / ⚠️ à vérifier), pas un cours.

Source de vérité : `.claude/waylo-state.md` (§2 gardes, §4 machine d'états, §6 workers,
D-c L306-308), `.claude/gotchas.md` (anti-TOCTOU), et le code réel cité ci-dessous.

## Quand l'utiliser
Auditer : routes `/api/admin/*`, toute écriture de `AdminAuditLog`, `deliveryProofStatus`,
la déduplication/idempotence d'un worker (DisputeResolutionWorker, penalty-worker,
transfer-worker). **Pas** pour écrire une nouvelle transition (→ `anti-toctou-idempotency`)
ni valider un reçu (→ `receipt-module`).

## A. `deliveryProofStatus` — transitions & droit d'écriture
Réf : `src/admin/arbitrage.route.ts` (PATCH `…/delivery-proof`), `src/services/arbitrage.service.ts` (`updateDeliveryProof`), `src/workers/disputeResolutionWorker.ts` (`verifyAbuse`).
- [ ] Écriture réservée admin : `isRequestAdmin(req.user.sub)` **avant** toute mutation, sinon `AppError('FORBIDDEN', 403)`. Auth en `onRequest` (non authentifié → 401 avant validation).
- [ ] Body *fail-closed* : `additionalProperties:false` + `enum` limité à `VALIDATED | REJECTED`. `PENDING` est le défaut initial, **jamais** une décision acceptée.
- [ ] Effet atomique : `updateDeliveryProof` écrit le statut **et** l'`AdminAuditLog` dans la même opération service — pas de trou d'audit.
- [ ] Source de vérité « abus » = `deliveryProofStatus === VALIDATED`, relu **frais DANS la `$transaction`** (jamais un booléen calculé hors tx).
- [ ] Route admin de confiance : mission absente → 400/404 explicite (pas de masquage IDOR, contrairement aux routes participant).

## B. `AdminAuditLog` — isolation & append-only
Réf : D-c (`waylo-state.md` L306-308), `arbitrage.route.ts` L146-148, `disputeResolutionWorker.ts` L242-249.
- [ ] Écrit dans la **même `$transaction`** que la transition d'état (invariant D-c) : write d'audit qui échoue ⇒ rollback intégral, jamais de décision sans trace.
- [ ] Discriminant `actor` **stable** : décision humaine = `actor:'ADMIN'` + `adminId:<sub>` ; entrée automatisée (worker) = `actor:'SYSTEM'` + `adminId:null`. Un log SYSTEM ne doit jamais porter d'`adminId` (et vice-versa).
- [ ] Pas de fuite cross-mission : chaque ligne porte son `missionId` ; aucune lecture d'audit n'agrège sans filtrer par mission/acteur.
- [ ] **Append-only** : aucun `update`/`delete` sur `AdminAuditLog` (miroir de l'invariant ledger §3). Repérer toute mutation d'une ligne existante.
- [ ] `action` = SNAKE_CASE stable (`ADMIN_ARBITRATE_FRAUD`, `ADMIN_RESOLVE_REFUND`/`_PAYOUT`, `INSTRUCTION_PENALTY_OPENED`).

## C. Déduplication des workers outbox
Réf : `disputeResolutionWorker.ts`, `waylo-state.md` §6.
- [ ] **ENQUEUE idempotent** : insertion d'intention sous `FOR UPDATE SKIP LOCKED` + `NOT EXISTS(… READY_FOR_REFUND)` → jamais deux intentions pour la même mission, sûr multi-instance.
- [ ] **CLAIM atomique** : `FOR UPDATE SKIP LOCKED`, `attempts++` committé **avant** l'appel Stripe (backoff naturel au crash, pas de re-traitement infini).
- [ ] Garde `inFlight` par process (jamais 2 ticks concurrents) + `.catch` de tick (une panne DB n'effondre pas le scheduler ; multi-instance couvert par les verrous).
- [ ] `idempotencyKey` Stripe déterministe par entité (`dispute_refund_<missionId>`, `penalty_debit_<outboxId>`) → un rejeu post-crash agit une seule fois.
- [ ] Effet terminal **once** : alerte critique émise une seule fois à l'abandon (seuil M=5).

## D. Robustesse crash — outbox de pénalité
Réf : `waylo-state.md` §6 + Sprint 15 (penalty-worker), `disputeResolutionWorker.ts` L228-251.
> ⚠️ Il n'existe **pas** de modèle `PenaltyEvent`. Entités réelles : `PenaltyDebitOutbox`
> (fraude 200%), `Penalty` (instruction, `ABUSIVE_CONTESTATION`), `OutboxEvent READY_FOR_REFUND`.
- [ ] Unicité DB : `PenaltyDebitOutbox.missionId @unique` (une ponction/mission) + `stripePaymentIntentId @unique` (un seul débit réussi) ; `Penalty.missionId @unique`.
- [ ] Création pénalité = `upsert` avec `update:{}` (no-op au rejeu) — jamais de doublon ni de réarmement.
- [ ] `deliveryProofStatus` **relu dans la tx** avant création de la pénalité d'instruction : un flip `VALIDATED→REJECTED` entre claim et commit ne crée pas de pénalité sur lecture périmée.
- [ ] Séquence règle d'or : charge off-session **hors tx** → sur succès **uniquement**, `cancel` du hold hors tx → `$transaction` (escrow `HELD→CANCELLED` conditionnel + outbox `SETTLED`). Échec → `FAILED` + backoff ; M=5 → `ABANDONED` + `PENALTY_DEBIT_ABANDONED` (critique, une fois).
- [ ] Libération du hold acheteur **conditionnée au recouvrement** : un abandon laisse l'escrow `HELD` (créance ouverte + hold non libéré = double action humaine, signalée dans l'alerte).

## Verdict
Lister les ❌ classés par gravité : **perte de fonds** > fuite/trou d'audit > double-exécution
> régression de masquage IDOR. Terminer par la seule action prioritaire.
