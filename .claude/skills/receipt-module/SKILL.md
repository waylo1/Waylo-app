---
name: receipt-module
description: "Invariants du module Receipt de Waylo, à appliquer en ÉCRIVANT/MODIFIANT la validation ou la réconciliation de reçus (inputGuard, receiptReconciliation, disputeGuard, schémas Zod de reçu) : montants en centimes Int sans Float, devise ISO 4217 ^[A-Z]{3}$, erreurs typées IntegrityViolation en SNAKE_CASE, fonctions pures sans I/O, couverture de branches 100%. NE PAS utiliser pour les transitions d'escrow (→ anti-toctou-idempotency) ni l'audit admin/worker (→ audit-security)."
---

# Invariants — module Receipt (validation & réconciliation)

Règles applicables à tout code de `src/services/inputGuard.ts`,
`receiptReconciliation.ts`, `disputeGuard.ts` et `src/schemas/receipt.ts`.

Source : `src/services/RECEIPT_MODULE.md`. Pipeline défensif en 3 couches : Input Guard
(strip métadonnées + détection d'injection) → Reconciliation (arithmétique pure) →
Dispute Guard (gel mission + alerte sur violation).

## Quand l'utiliser
En **touchant** la validation/réconciliation de reçus. **Pas** pour les transitions d'escrow
(→ `anti-toctou-idempotency`) ni l'audit admin/worker (→ `audit-security`).

## 1. Montants : centimes `Int`, zéro Float
- [ ] Tous les montants (`totalAmount`, `items[].price`) sont des **centimes entiers** ; tolérance flottante **nulle**.
- [ ] `price` est le **total de ligne** (pas le prix unitaire) ; `quantity` est informatif, **ignoré** dans la somme.
- [ ] Pas de contrôle de budget ici : le plafond est le métier de l'escrow (`spendingLimitCents`).

## 2. Devise : ISO 4217 strict
- [ ] `currency` validé par regex `^[A-Z]{3}$` (ex. `EUR`) au schéma Zod.
- [ ] Égalité stricte `receipt.currency === order.currency`, sinon `IntegrityViolation('CURRENCY_MISMATCH', …)`.

## 3. Erreurs typées `IntegrityViolation` (SNAKE_CASE)
- [ ] Toute violation d'intégrité **throw** `IntegrityViolation(code, expected, actual)` — jamais de retour `null`/`false` silencieux.
- [ ] Codes `SNAKE_CASE` stables : `ORDER_MISMATCH`, `CURRENCY_MISMATCH`, `TOTAL_MISMATCH`, `MANIPULATION_DETECTED`.
- [ ] Ordre *fail-fast* fixe dans `verifyReceiptIntegrity` : (1) `orderId`, (2) `currency`, (3) `sum(items.price) === totalAmount`.
- [ ] Defense-in-depth dans `reconcileExtractedReceipt` : `detectPromptInjection(ocrText)` **avant** `verifyReceiptIntegrity` (texte OCR hostile bloque la libération avant tout parsing).

## 4. Fonctions pures
- [ ] `verifyReceiptIntegrity`, `reconcileExtractedReceipt`, `detectPromptInjection` : **pures** (aucune I/O, aucun effet de bord, déterministes).
- [ ] Validation Zod **à la frontière de route** uniquement, pas à l'intérieur des fonctions pures.
- [ ] Escrow **jamais muté** dans un guard (conforme `escrow-guard`) ; la conséquence monétaire (gel via dispute + alerte `RECEIPT_INTEGRITY_VIOLATION` = `critical`) vit dans `disputeGuard` via dépendances injectées (DI testable).

## 5. Couverture de branches 100%
- [ ] Chaque branche de garde a un test dédié (succès + chaque code de violation, dans l'ordre).
- [ ] Inclure les cas adversariaux : obfuscation zero-width, fullwidth, faux marqueurs système, falsification de montant.
- [ ] Inclure les faux positifs légitimes (« return policy », « total refund within 30 days ») → ne doivent **pas** déclencher.
- [ ] Fail-closed image : format inconnu → `UnsupportedImageError` ; tronqué/malformé → `MalformedImageError`.

## Checklist de sortie
Centimes Int ✓ · ISO 4217 ✓ · `IntegrityViolation` SNAKE_CASE ✓ · pureté préservée ✓ ·
escrow non muté ✓ · branches 100% (succès + violations + adversarial + faux positifs) ✓.
