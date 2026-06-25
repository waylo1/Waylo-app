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

**Erreur supervisée:** `WatchdogExhaustedError` — re-throw systématique,
logging structuré avant propagation.

---
