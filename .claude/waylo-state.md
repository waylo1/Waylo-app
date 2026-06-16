# Waylo — État du système (source de vérité technique)

> Snapshot factuel du backend après **Sprints 1–4 (module Douane complet)**.
> Branche courante : `fix/sprint2-customs-receipt-sha256` (contient S1–S4).
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
| POST | `/:id/dropoff-receipt` | **voyageur** assigné (404 masquant pour un tiers) ; garde d'état `{MATCHED, VALIDATED}` (400 `INVALID_MISSION_STATE`) ; → `DEPOSITED` (preuve + tracking + `dropoffAt` serveur) |
| POST | `/:id/confirm-collection` | **acheteur** (404 masquant) ; garde d'état strict `DEPOSITED` (400 `INVALID_MISSION_STATE`) ; escrow HELD check → capture Stripe hors tx (`capture_collection_<id>`) → `DEPOSITED → VALIDATED` (transitoire) ; webhook → `RELEASED`. Aucun `transfers.create` ni ledger direct (chemin outbox existant) |
| POST | `/:id/dispute` | **acheteur** (404 masquant) ; garde d'état strict `DEPOSITED` (400 `INVALID_MISSION_STATE`) ; motif optionnel (Ajv ≤ 2000) ; `$transaction` → `DISPUTED` + `disputeReason`/`disputedAt` ; alerte critique post-commit `MISSION_DISPUTED_BY_BUYER`. Gèle la mission (aucun mouvement d'argent) |
| POST | `/:id/receive` | **acheteur** + rate-limit ; **déclencheur douane** |
| POST | `/:id/validate` | **acheteur** + **garde douane** (409 `CUSTOMS_REVIEW_PENDING`) |
| POST | `/:id/customs-receipt` | **voyageur** + rate-limit ; verrou → revue |
| POST | `/:id/customs-approve` | **admin** (`isAdmin`) ; escrow HELD check → capture Stripe hors tx (`capture_customs_<id>`) → **[D-c+S4] PENDING_CUSTOMS_REVIEW → VALIDATED + audit atomiques** ; webhook → RELEASED |
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
  fetch serveur des URLs (anti-SSRF) ; `destinationCountry` ISO-2 requis ;
  `customsReceiptSha256` : pattern `^[a-f0-9]{64}$` requis (**[D-b]** — hash des octets
  du document calculé côté client avant upload ; scellement content-addressed).
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
PENDING_CUSTOMS_REVIEW ──/customs-approve (admin, capture Stripe)──▶ VALIDATED (transitoire)
PENDING_CUSTOMS_REVIEW ──/customs-reject (admin)──▶ ESCROW_LOCKED_CUSTOMS (receipt effacé)
AWAITING_VALIDATION ──/validate (acheteur, capture)──▶ VALIDATED (transitoire)
{MATCHED | VALIDATED} ──/dropoff-receipt (voyageur, preuve de dépôt)──▶ DEPOSITED
DEPOSITED ──/confirm-collection (acheteur, capture Stripe)──▶ VALIDATED (transitoire)
DEPOSITED ──/dispute (acheteur, motif optionnel)──▶ DISPUTED (gel, arbitrage humain)
{AWAITING_VALIDATION | VALIDATED} ──webhook capture──▶ RELEASED (final)
webhook capture sans compte Connect vérifié ──▶ AWAITING_TRAVELER_ACCOUNT
charge.refunded (total) ──▶ REFUNDED   |   payment_failed ──▶ CANCELLED
```

Tous les états douaniers (`ESCROW_LOCKED_CUSTOMS`, `PENDING_CUSTOMS_REVIEW`) gardent
l'escrow **`HELD`** : la capture via `/validate` et `/api/escrow/:id/capture` y est
interdite (gardes §2). La capture est déclenchée par `/customs-approve` (chemin admin)
avec la clé `capture_customs_<missionId>` — distincte du chemin buyer (`capture_<missionId>`).
Après `VALIDATED` (transitoire), le webhook `payment_intent.succeeded` écrit le ledger
(CAPTURE + PAYOUT + COMMISSION), crée le `TransferOutbox` et finalise en **RELEASED**.
Seuils de minimis : [`customs.ts`](../src/missions/customs.ts) (US 800, GB 450, UE 430,
reste 150 — unités entières). **Timeout SLA** : missions bloquées en `ESCROW_LOCKED_CUSTOMS`
> 7 jours → annulation PI Stripe (`refund_customs_<id>`) + mission `REFUNDED` par le
worker de réconciliation (section 6).

**Dépôt voyageur** : `DEPOSITED` est atteint depuis `MATCHED` ou `VALIDATED` (post-douane)
via `/dropoff-receipt`. Champs scellés sur `Mission` : `dropoffReceiptUrl` (preuve de dépôt,
http(s) requis), `dropoffTrackingNumber?` (suivi transporteur, optionnel), `dropoffAt`
(horodatage **serveur**, jamais le device). État sans capture financière (purement logistique).

**Collecte acheteur** : `/confirm-collection` libère le séquestre depuis `DEPOSITED` SANS
appel `transfers.create` ni écriture ledger directe — il emprunte le chemin financier existant
(même contrat que `/validate` / `/customs-approve`) : capture Stripe hors tx (`capture_collection_<id>`)
→ transition `DEPOSITED → VALIDATED` (transitoire) → le webhook `payment_intent.succeeded`
journalise `PAYOUT`/`COMMISSION` + crée le `TransferOutbox` PENDING → le transfer-worker
(unique exécutant) exécute `transfers.create` → `RELEASED`. Aucune valeur d'enum `COMPLETED`
ni champ `travelerRewardCents` : le gain voyageur = `PAYOUT = capturé − commission` (invariant §3).

**Timeout collecte (SLA 5 jours)** : si l'acheteur ne confirme pas, `runReconciliation` §7
auto-libère toute mission `DEPOSITED` dont `dropoffAt` > 5 jours — même chemin que
`/confirm-collection` (capture `timeout_collection_<id>` hors tx → `VALIDATED` → webhook →
`RELEASED`). Échec de capture (carte expirée / erreur Stripe) → alerte **critique**
`COLLECTION_TIMEOUT_CAPTURE_FAILED` (mission reste `DEPOSITED`, intervention humaine), boucle non interrompue.

**Litige acheteur (gel)** : `/dispute` fait passer `DEPOSITED → DISPUTED` et enregistre
`disputeReason?` + `disputedAt` (serveur). `DISPUTED` n'est ciblé par **aucun** worker de
timeout (ni §7 collecte sur `DEPOSITED`, ni §6 douane sur `ESCROW_LOCKED_CUSTOMS`) : la
transition gèle de facto toute exécution automatique. Alerte critique post-commit
`MISSION_DISPUTED_BY_BUYER` (arbitrage humain). Aucun mouvement d'argent (escrow reste `HELD`).

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
   | `capture_customs_<missionId>` | `paymentIntents.capture` (T1-douane) | `/customs-approve` — chemin admin, distinct du chemin buyer |
   | `capture_collection_<missionId>` | `paymentIntents.capture` (T1-collecte) | `/confirm-collection` — chemin acheteur depuis `DEPOSITED` ; le transfert aval réutilise `transfer_marchand_<id>` (webhook → outbox → worker) |
   | `timeout_collection_<missionId>` | `paymentIntents.capture` (T1-timeout) | `runReconciliation` §7 — auto-libération si `DEPOSITED` > 5 j (acheteur inactif) ; même aval que la collecte manuelle |
   | `refund_customs_<missionId>` | `paymentIntents.cancel` (timeout) | worker `runReconciliation` section 6 (SLA > 7 j) |
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
- **reconciliation** (~24 h, boot différé 15 min) : invariants A/B/C + croisements Stripe
  + **section 6 timeout douanier** : `ESCROW_LOCKED_CUSTOMS` > 7 j → `paymentIntents.cancel`
  (`refund_customs_<id>`) → `$transaction(mission→REFUNDED + LedgerEntry REFUND 0)` ;
  échec Stripe → alerte `CUSTOMS_TIMEOUT_REFUND_FAILED` (ops) + `continue`.
  + **section 7 timeout collecte** : `DEPOSITED` (`dropoffAt` > 5 j) + escrow `HELD` →
  `paymentIntents.capture` (`timeout_collection_<id>`, hors tx) → `$transaction(mission→VALIDATED)` ;
  ledger/outbox portés par le webhook (aucune écriture comptable, aucun `transfers.create` ici) ;
  échec Stripe → alerte critique `COLLECTION_TIMEOUT_CAPTURE_FAILED` + `continue`.
- **funding-reconciliation** (~15 min) : rollback financements abandonnés (uniquement
  PI `requires_payment_method|requires_confirmation` — jamais `requires_capture`) +
  réparation des missions `FUNDED` orphelines (sans escrow).

---

## 7. Module Douane — correctifs Sprints 1–4

### Sprint 1 — Sécurité (D-a, D-c) · commit `15d81f4`
- **D-a** [`escrow.route.ts`](../src/escrow/escrow.route.ts) : `POST /api/escrow/:missionId/capture`
  reçoit la garde acheteur (404 masquant, **ferme l'IDOR**) + garde douane (409
  `CUSTOMS_LOCK_ACTIVE`) avant toute capture.
- **D-c** [`mission.route.ts`](../src/missions/mission.route.ts) : `customs-approve` et
  `customs-reject` écrivent la transition `Mission` **et** la ligne `AdminAuditLog`
  dans **une seule** `prisma.$transaction()` (plus de trou d'audit si le write échoue).
  L'alerte `CUSTOMS_RECEIPT_REJECTED` reste post-commit.

> Convention : `{ error: 'CUSTOMS_LOCK_ACTIVE' }` (clé `error`, cohérent avec CLAUDE.md).

### Sprint 2 — Intégrité preuve douanière (D-b) · commit `b7c4f03`
- **D-b** [`mission.route.ts`](../src/missions/mission.route.ts) : `POST /:id/customs-receipt`
  accepte `customsReceiptSha256` **du client** (sha256 des octets du document, calculé avant
  upload) au lieu d'un hash serveur de la chaîne URL. Schema Ajv `^[a-f0-9]{64}$` requis.
  Scellement content-addressed réel : l'admin peut vérifier le hash contre le document.

### Sprint 3 — Timeout & refund douane (D-d) · commit `0ed03ce`
- **D-d** [`reconciliation.ts`](../src/workers/reconciliation.ts) **section 6** :
  détecte `ESCROW_LOCKED_CUSTOMS` > 7 jours → `paymentIntents.cancel` (PI non capturé,
  `idempotencyKey: refund_customs_<id>`) → `$transaction(mission→REFUNDED + LedgerEntry REFUND 0)`.
  Échec Stripe → alerte `CUSTOMS_TIMEOUT_REFUND_FAILED` (ops, persistante) + continue.
  Nouveau code d'alerte ajouté dans [`alerts.ts`](../src/alerts.ts).

### Sprint 4 — Clôture financière douane (D-e) · commit `91d9ea2`
- **D-e** [`mission.route.ts`](../src/missions/mission.route.ts) : `POST /:id/customs-approve`
  clôt désormais le flow financier : escrow lookup (HELD check) → `paymentIntents.capture`
  **hors** `$transaction` (règle d'or) avec `idempotencyKey: capture_customs_<missionId>` →
  `$transaction(PENDING_CUSTOMS_REVIEW → VALIDATED + AdminAuditLog)`. Le webhook
  `payment_intent.succeeded` prend le relais : ledger CAPTURE + PAYOUT + COMMISSION +
  TransferOutbox + escrow RELEASED + **mission RELEASED** (final). Un retry admin après crash
  re-présente la même clé à Stripe (idempotent) puis réessaie la `$transaction`.

### Module Dépôt Voyageur — statut `DEPOSITED`
- **Schéma** [`schema.prisma`](../prisma/schema.prisma) : nouvelle valeur d'enum `MissionStatus.DEPOSITED`
  + 3 colonnes nullable sur `Mission` (`dropoffReceiptUrl`, `dropoffTrackingNumber`, `dropoffAt`).
  Migration `20260616201254_add_dropoff_to_mission` (enum `ADD VALUE` + colonnes nullable,
  rétro-compatible : aucun backfill requis).
- **Route** [`mission.route.ts`](../src/missions/mission.route.ts) : `POST /:id/dropoff-receipt`
  réservée au **voyageur assigné** — lookup `findMissionForTraveler` → **404 masquant** pour
  un tiers/acheteur (jamais 403 : pas d'oracle d'existence, même invariant IDOR que tout le
  module). Garde d'état `{MATCHED, VALIDATED}` (sinon 400 `INVALID_MISSION_STATE`) ; body Ajv
  `dropoffReceiptUrl` (http(s) requis, anti-XSS) + `dropoffTrackingNumber?` optionnel (sinon
  400 `INVALID_INPUT`). Transition conditionnelle `updateMany` dans `$transaction` (anti-TOCTOU),
  `dropoffAt` scellé serveur. Aucun appel Stripe (état logistique, pas financier).

### Module Collecte Acheteur — `/confirm-collection`
- **Route** [`mission.route.ts`](../src/missions/mission.route.ts) : `POST /:id/confirm-collection`
  réservée à l'**acheteur** (lookup `findMissionForBuyer` → **404 masquant**). Garde d'état
  strict `DEPOSITED` (sinon 400 `INVALID_MISSION_STATE`) + précondition escrow `HELD`
  (sinon 400 `ESCROW_NOT_HELD`). Capture Stripe **hors tx** (`capture_collection_<id>`) →
  `$transaction` transition conditionnelle `DEPOSITED → VALIDATED` (anti-TOCTOU). Le webhook
  finalise → `RELEASED`. **Décision d'archi** (vs spec littérale) : pas de `transfers.create`
  inline, pas d'écriture ledger directe, pas de statut `COMPLETED` ni champ `travelerRewardCents`
  — le versement passe par le chemin outbox existant (invariant §5 : worker = unique exécutant)
  et le gain voyageur reste `PAYOUT = capturé − commission` (préserve l'invariant ledger B).

### Worker Timeout Collecte — `runReconciliation` §7
- **Worker** [`reconciliation.ts`](../src/workers/reconciliation.ts) §7 + [`alerts.ts`](../src/alerts.ts) :
  auto-libération des missions `DEPOSITED` inactives > 5 j (`dropoffAt`). Capture
  `timeout_collection_<id>` hors tx → `DEPOSITED → VALIDATED` (le webhook finalise comme
  pour la collecte manuelle). Nouveau code d'alerte `COLLECTION_TIMEOUT_CAPTURE_FAILED`
  (**critical**) sur échec de capture. Aucun `transfers.create` ni écriture ledger dans le
  worker (pattern outbox + invariant B préservés). Miroir capture du timeout douanier §6.

### Module Litige Acheteur — statut `DISPUTED`
- **Schéma** [`schema.prisma`](../prisma/schema.prisma) : valeur d'enum `MissionStatus.DISPUTED`
  + colonnes nullable `disputeReason` / `disputedAt` sur `Mission`. Migration
  `20260616205254_add_dispute_to_mission` (enum `ADD VALUE` + colonnes nullable, rétro-compatible).
- **Route** [`mission.route.ts`](../src/missions/mission.route.ts) : `POST /:id/dispute`
  réservée à l'**acheteur** (`findMissionForBuyer` → 404 masquant). Garde d'état strict
  `DEPOSITED` (400 `INVALID_MISSION_STATE`). `$transaction` conditionnelle (anti-TOCTOU)
  `DEPOSITED → DISPUTED` + motif/horodatage serveur. Alerte critique **post-commit**
  `MISSION_DISPUTED_BY_BUYER` ([`alerts.ts`](../src/alerts.ts)) — convention safeEmit
  (hors tx, ne casse pas la route). **Sécurité fonds** : `DISPUTED` gèle la mission (hors
  périmètre des workers de timeout §6/§7), aucun mouvement d'argent (escrow reste `HELD`).
  > Décision : migration (enum + 2 colonnes) autorisée par l'instruction §4 ; alerte émise
  > post-commit (et non « dans la $transaction ») conformément à la convention safeEmit du codebase.

**État de validation global** : `npx tsc --noEmit` → 0 erreur ; `npx vitest run` → **21 fichiers,
128 tests verts** (+6 litige). Fichiers litige : `schema.prisma`, migration
`20260616205254_add_dispute_to_mission`, `alerts.ts`, `mission.route.ts`, `dispute.test.ts`
(nouveau), ce fichier.
