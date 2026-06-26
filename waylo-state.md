# Waylo — État du projet

---

## Automation Infra

**Status:** Active  
**Package:** `@waylo/shared/automation`  
**Intégré dans:** escrowPayoutWorker · dispute-handler · webhook-validator

| Alias            | Entité cible | idempotencyKey pattern        | Statut   |
|------------------|--------------|-------------------------------|----------|
| stripe-capture   | Mission      | `capture:${missionId}`        | ✅ Actif |
| dispute-resolve  | Dispute      | `dispute:${disputeId}`        | ✅ Actif |
| webhook-retry    | StripeEvent  | `webhook:${webhookEventId}`   | ✅ Actif |
| mission-created  | Mission      | `${missionId}`                | ✅ Actif |

**Erreur supervisée:** `WatchdogExhaustedError` — re-throw systématique,
logging structuré avant propagation.

---

## MISSION-00 ✓ — Migration MissionStatus + alias mission-created

- `MissionStatus.NOTIFICATION_FAILED` ajouté (migration `20260625220000`)
- `ProcessedMissionEvent` créé (ledger idempotence, sans FK, `@@unique([alias, missionId])`)
- Alias `'mission-created'` enregistré dans `registerBuiltinAliases()`

## MISSION-01 ✓ — Cycle de vie Mission + Watchdog

- `src/missions/mission.service.ts` : `triggerMissionCreatedNotification` avec idempotence permanente via `ProcessedMissionEvent` + catch `WatchdogExhaustedError` → `NOTIFICATION_FAILED`
- `src/missions/routes/crud.route.ts` : fire-and-forget post-commit
- `src/missions/mission.test.ts` : 3 tests (runAlias args, idempotence, NOTIFICATION_FAILED)
- **Décision idempotence** : `runAlias.idempotencyKey` = label de traçage uniquement → `ProcessedMissionEvent` = source de vérité permanente
- `tests/helpers/db-reset.ts` : ajout `processedMissionEvent.deleteMany()`
- **Tests :** 371/371 ✅

---

## MISSION-ASSIGN-01 ✓ — Assignation Mission (Traveler side)

- `prisma/schema.prisma` : `MissionStatus.ACTIVE` + modèle `ProcessedAssignmentEvent` (`missionId @unique`)
- `prisma/migrations/20260625211449_mission_assign_active/` : `ALTER TYPE ADD VALUE 'ACTIVE'` + `CREATE TABLE ProcessedAssignmentEvent`
- `src/missions/routes/assign.route.ts` : `POST /:id/assign` — pré-lecture 404/403, check idempotent pre-tx (même travelerId → 200), `prisma.$transaction(updateMany + create)` atomique, 409 si count=0
- `src/missions/routes/index.ts` : enregistrement `assignRoutes`
- `src/missions/mission.test.ts` : +6 tests (succès, idempotent séquentiel, concurrence 1×200+1×409, 404, 403, autre voyageur → 409)
- **Tests :** 377/377 ✅

## MISSION-ASSIGN-01-LOCK ✓ — Race test on real Postgres + post-race invariant, enum migration guard

- **Moteur test concurrence : PostgreSQL local (localhost:5433/waylo_test) — CAS A.**
- Invariant post-race ajouté au test de concurrence : `processedAssignmentEvent.count===1`, `mission.status===ACTIVE`, `mission.travelerId===gagnant`.
- [GATE-3] vérifié manuellement : retirer `WHERE status='CREATED'` → 2 tests cassés (2×200 au lieu de 1×200+1×409) ; WHERE remis → 377/377 ✅. Le lock Postgres est le seul garde-fou, pas Node.
- `migration.sql` : commentaire `ADD VALUE` anti-backfill dans même fichier.
- `CLAUDE.md` : règle enum migration ajoutée dans Conventions critiques.
- **Tests :** 377/377 ✅

## RBAC-02 — non requis

- Modèle ressource-based actuel (Mission.buyerId / Mission.travelerId / User.isAdmin) couvre tous les cas d'autorisation des routes existantes. Aucun nouveau rôle introduit.

## NOTIF-01 ✓ — Notifications d'acteurs (idempotent)

- `src/notifications/notification.service.ts` : `NotificationSink` (injectable), `NotificationPayload` (whitelist — pas de PII/sensible), `notifyActor` (idempotence via `ProcessedMissionEvent` namespace `notif:*`, no-op sur P2002)
- `src/missions/routes/assign.route.ts` : accroche fire-and-forget post-tx `notif:mission-matched` → `mission.buyerId` (seul point câblé — Option A)
- `src/notifications/notification.test.ts` : 3 tests (émission correcte, idempotence double-trigger, anti-fuite payload)
- **Accroches documentées (non câblées)** : `notif:capture-confirmed`, `notif:delivery-validated`, `notif:dispute-opened`, `notif:dispute-resolved` — stubs `// wire:` dans le service
- **Tests :** 383/383 ✅

## MISSION-02 ✓ — Dashboard Voyageur (Lecture Sécurisée)

- `src/missions/mission.service.ts` : `PublicMissionDTO` (whitelist explicite) + `toPublicMissionDTO` (guard `travelerId` non-null) + `findMissionsForTraveler` (filtre Prisma `WHERE travelerId + status IN [ACTIVE, COMPLETED_BY_BUYER]`, `select` défensif)
- `src/missions/routes/list.route.ts` : `GET /my-missions` — travelerId = `req.user.sub`, retourne `PublicMissionDTO[]`, pas de filtre post-fetch
- `src/missions/routes/index.ts` : enregistrement `listRoutes` (2 lignes strictement)
- `src/missions/mission.test.ts` : +3 tests (succès 2 missions, isolement A≠B, filtre CREATED exclu)
- **Décision DTO** : `COMPLETED` de la spec = `MissionStatus.COMPLETED_BY_BUYER` ; `select` Prisma = défense en profondeur contre fuite de champs internes
- **Tests :** 380/380 ✅

---

## HOTFIX-AUDIT-01 ✓ — Suppression token magic-link des logs (PII)

- `src/auth/auth.service.ts:12` : `noopTransport` — token OTP supprimé du `console.log`, paramètre renommé `_token` (TS strict)
- **Tests :** 383/383 ✅ — commit `fbc82ba`

## HOTFIX-AUDIT-02 ✓ — Re-vérification atomique escrow dans customs-approve (TOCTOU P1)

- `src/missions/routes/admin.route.ts` : `/customs-approve` — garde 3a ajoutée dans `$transaction` post-capture : re-lit `escrow.status` après l'appel Stripe (hors tx), abort avec `ESCROW_INVARIANT_VIOLATED` (500 + `safeEmit`) si non-HELD ; escrow.status sera toujours HELD en pratique (invariant Stripe prouvé), garde = détecteur d'anomalie opérationnelle
- `src/alerts.ts` : `ESCROW_INVARIANT_VIOLATED` ajouté au type `AlertCode` (severity `critical`) — requis par TS strict
- `src/missions/customs-approve.test.ts` : test (F) garde 3a via mock Stripe injectant CANCELLED pendant capture → 500 + mission inchangée
- **Décision Option B** : Stripe hors tx réelle (pas de FOR UPDATE pendant appel réseau), re-check en READ COMMITTED post-capture dans tx courte sans appel réseau
- **Tests :** 384/384 ✅ — commit `a931779`

## AUDIT-03 ✓ — Audit pré-beta adversarial — GO BETA ✓ (2026-06-26)

- **Verdict :** GO BETA ✓ — P0 : 0 · P1 : 2 (tous corrigés) · P2 : 4 (dettes documentées)
- **P1 corrigés :** magic-link PII log (HOTFIX-01) + customs-approve TOCTOU (HOTFIX-02)
- **P2 documentés :** Math.round cents (arbitrage.route.ts:107) · TSA RFC3161 absent · Haversine/géolocalisation absente · GET /missions sans whitelist DTO
- **Dimensions validées :** isolation données ✓ · atomicité TOCTOU ✓ · idempotence Stripe+notif ✓ · RBAC ressource-based ✓ · secrets/PII ✓ · QPP 2/4 preuves (TSA+géoloc = dette légale) · WIP propre ✓
- **Tests :** 384/384 ✅

---
