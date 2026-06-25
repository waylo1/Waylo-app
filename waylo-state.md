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
