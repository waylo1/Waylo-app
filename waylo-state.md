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

---
