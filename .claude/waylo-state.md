# Waylo — État du système (source de vérité technique)

> Snapshot factuel du backend après **Sprint 1 sécurité (D-a, D-c)**.
> Branche : `fix/sprint1-security-d-a-d-c`. Généré depuis le code, pas des suppositions.
> En cas de divergence code ↔ doc, **le code prime** — mettre ce fichier à jour.

---

## 1. Routes Fastify actives

Préfixes montés dans [`src/app.ts`](../src/app.ts) : `/api/auth`, `/api/missions`,
`/api/escrow`, `/api/stripe`. Toutes les routes hors `/health` et `/api/stripe/*`
sont protégées par JWT (`authenticate` : Bearer **ou** cookie HttpOnly).
Format d'erreur uniforme : `{ error: 'SNAKE_CASE_CODE' }`.

### Publiques (aucun JWT)
| Méthode | Route | Garde / note |
|---|---|---|
| GET | `/health` | aucune |
| POST | `/api/auth/register` | rate-limit (IP+email), 409 si email pris |
| POST | `/api/auth/login` | rate-limit ; 401 générique `INVALID_CREDENTIALS` (anti-oracle timing) |
| POST | `/api/auth/logout` | purge cookie |

### Auth (JWT)
| Méthode | Route | Garde / note |
|---|---|---|
| POST | `/api/auth/refresh` | session glissante |
| GET | `/api/auth/me` | relit la DB → 401 si compte supprimé / KYC frais |

### Missions (JWT, `onRequest: authenticate`) — autorisation **PAR RESSOURCE**
| Méthode | Route | Acteur / garde |
|---|---|---|
| POST | `/api/missions` | auth (devient acheteur) |
| GET | `/api/missions` | auth (ses missions : buyer OU traveler) |
| GET | `/api/missions/available` | auth (FUNDED, pas les siennes) |
| GET | `/api/missions/:id` | **participant** (404 masquant pour un tiers) |
| POST | `/:id/intent` | **acheteur** — financement T0 |
| POST | `/:id/checkout-session` | **acheteur** — financement T0 (Checkout) |
| POST | `/:id/match` · `/:id/accept` | non-acheteur, statut `FUNDED` |
| POST | `/:id/start-travel` | **voyageur** assigné |
| POST | `/:id/ship` | **voyageur** ; refuse `purchaseAmountCents > budget` |
| POST | `/:id/submit-receipt` | **voyageur** ; refuse montant > budget ; scelle Receipt |
| POST | `/:id/receive` | **acheteur** + rate-limit ; **déclencheur douane** |
| POST | `/:id/validate` | **acheteur** + **garde douane** (409 `CUSTOMS_REVIEW_PENDING`) |
| POST | `/:id/customs-receipt` | **voyageur** + rate-limit ; verrou → revue |
| POST | `/:id/customs-approve` | **admin** (`isAdmin`) ; **[D-c] transition+audit atomiques** |
| POST | `/:id/customs-reject` | **admin** ; **[D-c] atomique** + alerte post-commit |
| GET | `/api/missions/customs-pending` | **admin** ; file de revue |

### Escrow (JWT, `onRequest: authenticate`)
| Méthode | Route | Garde / note |
|---|---|---|
| POST | `/api/escrow/:missionId/capture` | **[D-a] acheteur** (404 masquant) + **garde douane** (409 `CUSTOMS_LOCK_ACTIVE`) ; délègue à `captureEscrowFunds` (capture Stripe seule, 0 écriture DB) |

### Stripe (signature `constructEvent`, **JAMAIS** JWT)
| Méthode | Route | Note |
|---|---|---|
| POST | `/api/stripe/issuing-authorization` | secret dédié `STRIPE_ISSUING_WEBHOOK_SECRET` ; JIT < 2 s ; **refus par défaut** (fail-safe) ; 1 lecture indexée + comparaison |
| POST | `/api/stripe/webhook` | secret `STRIPE_WEBHOOK_SECRET` ; events async ; idempotent (cf. §5) |

---

## 2. Guards de sécurité

- **Autorisation par ressource** ([`mission-access.ts`](../src/missions/mission-access.ts)) :
  `findMissionForParticipant` / `findMissionForBuyer` / `findMissionForTraveler`.
  Aucun rôle de compte — acheteur/voyageur dérivé de `buyerId` / `travelerId`.
  Mission absente **ou** appelant non autorisé → `null` → **404** (jamais 403 :
  l'existence d'une mission n'est jamais révélée à un tiers).
- **Garde admin** ([`mission.route.ts`](../src/missions/mission.route.ts) `isRequestAdmin`) :
  *fail-closed* sur le flag DB `User.isAdmin` (source de vérité unique, auditable).
  Compte absent / supprimé / `isAdmin:false` → 403. Remplace l'ancienne allowlist
  `ADMIN_USER_IDS` (env) — supprimée.
- **Garde douane** (2 chemins, même intention) : `/validate` (409 `CUSTOMS_REVIEW_PENDING`)
  et **`/api/escrow/:id/capture`** (409 `CUSTOMS_LOCK_ACTIVE`, **D-a**). Aucune capture
  possible tant que `status ∈ {ESCROW_LOCKED_CUSTOMS, PENDING_CUSTOMS_REVIEW}`.
- **Backstop webhook** : `handleCapture` abort `CUSTOMS_LOCK_CAPTURED` si une capture
  atteint malgré tout une mission verrouillée (rollback intégral).
- **JIT fail-safe** : doute / erreur DB / carte inconnue / escrow non `HELD` → `approved:false`.
- **Auth** : argon2 ; JWT `{ sub }` (identité seule, aucun rôle) ; rate-limit register/login/receive/customs-receipt.
- **Entrées** : schémas Ajv stricts ; URLs `^https?://` (anti-XSS stocké) ; pas de
  fetch serveur des URLs (anti-SSRF) ; `destinationCountry` ISO-2 requis.
- **Webhooks** : `constructEvent()` obligatoire (signature), même en dev ; parser raw
  scopé à chaque plugin Stripe.

---

## 3. Invariants ledger (LedgerEntry **append-only** — jamais d'UPDATE/DELETE)

Vérifiés (lecture seule, n'altèrent jamais le ledger) par
[`runReconciliation`](../src/workers/reconciliation.ts) ; tout écart = alerte, pas une correction.

- **A.** `Σ(CAPTURE) == EscrowTransaction.capturedAmountCents` — pour **tout** escrow.
- **B.** `Σ(PAYOUT + COMMISSION + REFUND) ≤ Σ(CAPTURE)` — pour **tout** escrow.
- **C.** `status ∈ {RELEASED, REFUNDED} ⇒ Σ(PAYOUT+COMMISSION+REFUND) == Σ(CAPTURE)`.

Écritures par phase : `CAPTURE` + `capturedAmountCents` → **T2** (webhook
`payment_intent.succeeded`) ; `PAYOUT` + `COMMISSION` → **T3** (libération, même
transaction) ; `REFUND` (delta vs cumul Stripe) → **T2'** (`charge.refunded`, sous
verrou `FOR UPDATE`). Montant : `payout = capturé − commission` ; `commission` =
frais plateforme. **Argent en centimes `Int` partout.**

> Garde-fou monétaire : `payoutCents < 0` (commission > capturé) → abort
> `NEGATIVE_PAYOUT` ; `Σ(REFUND) > capturedAmountCents` → abort `OVER_REFUND`.

---

## 4. Machine d'états `MissionStatus`

```
CREATED ──/intent|/checkout-session (réservation atomique)──▶ FUNDED
        ◀── funding-recon (PI jamais autorisé, > stale) ─────┘
FUNDED ──/match|/accept──▶ MATCHED ──/start-travel|/ship──▶ IN_PROGRESS
IN_PROGRESS ──/submit-receipt──▶ AWAITING_VALIDATION
IN_PROGRESS ──/receive (sous seuil douanier)──▶ VALIDATED (transitoire)
IN_PROGRESS ──/receive (≥ seuil, quittance absente)──▶ ESCROW_LOCKED_CUSTOMS
ESCROW_LOCKED_CUSTOMS ──/customs-receipt (voyageur)──▶ PENDING_CUSTOMS_REVIEW
PENDING_CUSTOMS_REVIEW ──/customs-approve (admin)──▶ IN_PROGRESS
PENDING_CUSTOMS_REVIEW ──/customs-reject (admin)──▶ ESCROW_LOCKED_CUSTOMS (receipt effacé)
AWAITING_VALIDATION ──/validate (acheteur, capture)──▶ VALIDATED (transitoire)
{AWAITING_VALIDATION | VALIDATED} ──webhook capture──▶ RELEASED (final)
webhook capture sans compte Connect vérifié ──▶ AWAITING_TRAVELER_ACCOUNT
charge.refunded (total) ──▶ REFUNDED   |   payment_failed ──▶ CANCELLED
```

Tous les états douaniers (`ESCROW_LOCKED_CUSTOMS`, `PENDING_CUSTOMS_REVIEW`) gardent
l'escrow **`HELD`** : la capture y est interdite (gardes §2). Seuils de minimis :
[`customs.ts`](../src/missions/customs.ts) (US 800, GB 450, UE 430, reste 150 — unités entières).

Toute transition = `updateMany` **conditionnel** (`where: { status: <attendu> }`)
dans `prisma.$transaction()` ; `count !== 1` → abort + code métier (anti-TOCTOU).

---

## 5. Idempotence & clés déterministes

**4 piliers** (à ne JAMAIS régresser en intégrant la douane au flow financier) :

1. **`ProcessedStripeEvent.stripeEventId @unique`** écrit dans la **même** transaction
   que l'effet métier → rejeu du même event = 200 sans effet, sans throw.
2. **`idempotencyKey` Stripe déterministes** (persistées, jamais recalculées) :

   | Clé | Opération Stripe | Émis par |
   |---|---|---|
   | `fund_<missionId>` | `paymentIntents.create` (T0) | `/intent` |
   | `checkout_<missionId>` | `checkout.sessions.create` | `/checkout-session` |
   | `capture_<missionId>` | `paymentIntents.capture` (T1) | `/validate`, `/receive`, `captureEscrowFunds` |
   | `transfer_marchand_<missionId>` | `transfers.create` (T4) | `handleCapture` → réutilisée telle quelle par le worker |

3. **Contraintes `@unique` DB** : `EscrowTransaction.{missionId, stripePaymentIntentId,
   idempotencyKey (escrow_fund_<missionId>), stripeIssuingCardId}` ;
   `TransferOutbox.{idempotencyKey, stripeTransferId}` ;
   `IssuingAuthorizationLog.stripeAuthorizationId` ; `Receipt.missionId` ;
   `ProcessedStripeEvent.stripeEventId`.
4. **Verrous de ligne** `SELECT … FOR UPDATE` (capture/refund concurrents sur un même
   escrow) et `FOR UPDATE SKIP LOCKED` (claim du transfer-worker).

**Règle d'or** : aucun appel Stripe à l'intérieur d'une `prisma.$transaction()`.
La capture est déclenchée hors transaction ; l'effet DB est porté par le webhook.
Le **TransferOutbox** (pattern outbox) est le seul chemin qui exécute un versement.

---

## 6. Workers (cron `setInterval` monoprocess — PAS d'Inngest)

Démarrés côte à côte dans [`server.ts`](../src/server.ts), chacun avec garde `inFlight`
(jamais 2 runs concurrents) + arrêt gracieux :
- **transfer-worker** (~1 min) : `PENDING|FAILED(backoff 2^n)|SUBMITTED(>15 min)` →
  `SUBMITTED` → `SETTLED | FAILED | ABANDONED` (terminal après M=5, alerte unique).
- **reconciliation** (~24 h, boot différé 15 min) : invariants A/B/C + croisements Stripe.
- **funding-reconciliation** (~15 min) : rollback financements abandonnés (uniquement
  PI `requires_payment_method|requires_confirmation` — jamais `requires_capture`) +
  réparation des missions `FUNDED` orphelines (sans escrow).

---

## 7. Sprint 1 — correctifs appliqués

- **D-a** [`escrow.route.ts`](../src/escrow/escrow.route.ts) : `POST /api/escrow/:missionId/capture`
  reçoit la garde acheteur (404 masquant, ferme l'IDOR) + garde douane (409
  `CUSTOMS_LOCK_ACTIVE`) avant toute capture.
- **D-c** [`mission.route.ts`](../src/missions/mission.route.ts) : `customs-approve` et
  `customs-reject` écrivent la transition `Mission` **et** la ligne `AdminAuditLog`
  dans **une seule** `prisma.$transaction()` (plus de trou d'audit si le write échoue).
  L'alerte `CUSTOMS_RECEIPT_REJECTED` reste **post-commit** (hors transaction).

> ⚠️ **Décision de convention** : la garde douane renvoie `{ error: 'CUSTOMS_LOCK_ACTIVE' }`
> (clé `error`) et non `{ code: ... }` comme suggéré, pour rester cohérent avec le
> contrat d'erreur du reste du codebase (CLAUDE.md). À rebasculer en `code` si voulu.

**État de validation** : `npx tsc --noEmit` → 0 erreur ; `npx vitest run` → 17 fichiers,
106 tests verts. Périmètre des modifications : `escrow.route.ts`, `mission.route.ts`,
+ ce fichier. Aucun autre fichier touché.
