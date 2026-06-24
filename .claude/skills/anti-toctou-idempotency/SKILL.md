---
name: anti-toctou-idempotency
description: "Pattern canonique à appliquer en ÉCRIVANT une nouvelle transition de statut financier ou un handler de webhook Stripe dans Waylo : transition atomique par updateMany conditionnel avec contrôle du rowcount (anti-TOCTOU) et idempotence d'event via ProcessedStripeEvent @unique dans la MÊME prisma.$transaction, sous la règle d'or « aucun appel Stripe dans une transaction ». NE PAS utiliser pour auditer du code existant (→ audit-security) ni pour les invariants de reçus (→ receipt-module)."
---

# Pattern canonique — transition financière atomique & idempotente

À appliquer en **écrivant** toute écriture d'argent ou transition de `MissionStatus` /
`EscrowStatus` (capture, libération, refund, ledger, outbox, webhook Stripe).

Source : `.claude/gotchas.md` §Anti-TOCTOU (L19-33) + `.claude/waylo-state.md` §5 Idempotence
(L233-268). Exemples ci-dessous **extraits verbatim** du code en place.

## Quand l'utiliser
En **implémentant** une nouvelle transition financière / un handler d'event Stripe. **Pas**
pour auditer l'existant (→ `audit-security`) ni pour les reçus (→ `receipt-module`).

## 1. Transition atomique anti-TOCTOU (`updateMany` conditionnel + rowcount)
Jamais de `findUnique` puis `update` séparés (fenêtre de course : double libération / double
refund). La transition est **une seule** écriture conditionnelle sur le statut attendu, et on
**vérifie le rowcount** : `count !== 1` ⇒ état incompatible ⇒ abort, pas d'exception silencieuse.

Extrait réel — `src/admin/arbitrage.route.ts` (L110-116) :
```ts
const updated = await tx.mission.updateMany({
  where: { id, status: MissionStatus.DISPUTED },   // garde d'état DANS l'écriture
  data:  { status: MissionStatus.DISPUTED_FRAUD },
})
// Transition perdue (course / déjà arbitrée) : rollback intégral, aucune écriture.
if (updated.count !== 1) throw new AppError('MISSION_NOT_DISPUTED', 400)
```

Variante verrou de ligne quand il faut lire un cumul AVANT d'écrire (refund vs capture
concurrents sur le même escrow) — `src/stripe/webhook.route.ts` (L271) :
```ts
await tx.$queryRaw`SELECT id FROM "EscrowTransaction" WHERE id = ${escrow.id} FOR UPDATE`
```
Au claim d'un worker : `FOR UPDATE SKIP LOCKED` (sérialise les instances concurrentes).

## 2. Idempotence d'event Stripe (`ProcessedStripeEvent` dans la même tx)
`ProcessedStripeEvent.stripeEventId @unique` et l'effet métier sont écrits dans la **même**
`prisma.$transaction` : soit les deux committent, soit rien. Un event rejoué trouve sa ligne
et ressort **200 sans effet, sans throw**. Deux livraisons concurrentes : l'une commit,
l'autre casse sur le `@unique` → rollback → 500 → retry Stripe → détecté en doublon → 200.

Extrait réel — `src/stripe/webhook.route.ts` (L88-100) :
```ts
outcome = await prisma.$transaction(async tx => {
  const seen = await tx.processedStripeEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { id: true },
  })
  if (seen) return { duplicate: true, handled: false, deferredAlerts: [] }

  await tx.processedStripeEvent.create({
    data: { stripeEventId: event.id, type: event.type },
  })
  const effect = await applyBusinessEffect(tx, event, abortAlert)   // effet métier MÊME tx
  return { duplicate: false, ...effect }
})
```

## 3. Règle d'or — aucun appel Stripe dans une `$transaction`
La capture/cancel/transfer Stripe se déclenche **hors** transaction (avec une `idempotencyKey`
déterministe **persistée, jamais recalculée**) ; l'effet DB est porté par le webhook. Le
`TransferOutbox` est le seul chemin qui exécute un versement.

Clés déterministes en vigueur (`waylo-state.md` §5 — réutiliser, ne pas réinventer) :
`fund_<missionId>`, `capture_<missionId>`, `capture_customs_<missionId>`,
`capture_collection_<missionId>`, `admin_refund_<missionId>`, `admin_payout_<missionId>`,
`refund_customs_<missionId>`, `dispute_refund_<missionId>`, `penalty_debit_<outboxId>`,
`penalty_release_<missionId>`, `transfer_marchand_<missionId>`.

## Checklist d'écriture
- [ ] Transition = `updateMany` conditionnel (`where:{ status: <attendu> }`) dans `$transaction` ; `count !== 1` → abort + code `SNAKE_CASE`.
- [ ] Aucun `findUnique`+`update` séparé ; lecture-puis-écriture d'un cumul ⇒ `SELECT … FOR UPDATE`.
- [ ] Event Stripe : `ProcessedStripeEvent` find/create + effet métier dans **une seule** `$transaction`.
- [ ] Aucun appel Stripe à l'intérieur de la `$transaction` ; `idempotencyKey` déterministe et persistée.
- [ ] Argent en **centimes `Int`** partout ; alertes émises post-commit (`safeEmit`), jamais dans la tx.
- [ ] Test : rejeu du même event ⇒ un seul effet (modèle `webhook.idempotence.test.ts`).
