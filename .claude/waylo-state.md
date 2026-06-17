# Waylo — État du système (source de vérité technique)

> Snapshot factuel du backend après **Sprints 1–4 (module Douane complet)**.
> Branche courante : `fix/sprint2-customs-receipt-sha256` (contient S1–S4).
> En cas de divergence code ↔ doc, **le code prime** — mettre ce fichier à jour.

---

## 1. Routes Fastify actives

Préfixes montés dans [`src/app.ts`](../src/app.ts) : `/api/auth`, `/api/missions`,
`/api/escrow`, `/api/admin`, `/api/stripe`. Toutes les routes hors `/health` et `/api/stripe/*`
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
| POST | `/:id/match` · `/:id/accept` | non-acheteur, statut `FUNDED` ; **hardening voyageur (S13)** : `stripePaymentMethodId` requis sinon 400 `TRAVELER_CARD_MISSING` (carte de garantie, après les checks own-mission/statut) |
| POST | `/:id/start-travel` | **voyageur** assigné |
| POST | `/:id/ship` | **voyageur** ; refuse `purchaseAmountCents > budget` |
| POST | `/:id/submit-receipt` | **voyageur** ; refuse montant > budget ; scelle Receipt |
| POST | `/:id/dropoff-receipt` | **voyageur** assigné (404 masquant pour un tiers) ; garde d'état `{MATCHED, VALIDATED}` (400 `INVALID_MISSION_STATE`) ; → `DEPOSITED` (preuve + tracking + `dropoffAt` serveur) |
| POST | `/:id/confirm-collection` | **acheteur** (404 masquant) ; garde d'état strict `DEPOSITED` (400 `INVALID_MISSION_STATE`) ; escrow HELD check → capture Stripe hors tx (`capture_collection_<id>`) → `DEPOSITED → VALIDATED` (transitoire) ; webhook → `RELEASED`. Aucun `transfers.create` ni ledger direct (chemin outbox existant) |
| POST | `/:id/dispute` | **acheteur** (404 masquant) ; garde d'état strict `DEPOSITED` (400 `INVALID_MISSION_STATE`) ; motif optionnel (Ajv ≤ 2000) ; `$transaction` → `DISPUTED` + `disputeReason`/`disputedAt` ; alerte critique post-commit `MISSION_DISPUTED_BY_BUYER`. Gèle la mission (aucun mouvement d'argent) |
| POST | `/:id/admin/resolve-refund` | **admin** (`isRequestAdmin`) ; garde état strict `DISPUTED` (400 `MISSION_NOT_DISPUTED`) ; escrow HELD check → `paymentIntents.cancel` hors tx (`admin_refund_<id>`) → `$transaction(DISPUTED → CANCELLED + AdminAuditLog)`. Arbitrage **faveur acheteur** : annule le hold non capturé |
| POST | `/:id/admin/resolve-payout` | **admin** (`isRequestAdmin`) ; garde état strict `DISPUTED` (400 `MISSION_NOT_DISPUTED`) ; escrow HELD check → `paymentIntents.capture` hors tx (`admin_payout_<id>`) → `$transaction(DISPUTED → VALIDATED + AdminAuditLog)` ; webhook → RELEASED. Arbitrage **faveur voyageur** |
| POST | `/:id/drop-off` | **voyageur** assigné (404 masquant acheteur/tiers — invariant IDOR) ; garde état strict `IN_PROGRESS` (400 `MISSION_NOT_IN_PROGRESS`) ; `$transaction` anti-TOCTOU → champs `dropOff*` + `droppedAt` serveur + `IN_PROGRESS → AWAITING_VALIDATION` |
| POST | `/:id/reviews` | **participant** (buyer OU traveler) ; statut terminal (`RELEASED` ou `CANCELLED`) sinon 400 `MISSION_NOT_TERMINAL` ; targetId dérivé automatiquement (l'autre partie) ; doublon → 409 `REVIEW_ALREADY_SUBMITTED` ; tiers → 404 (invariant IDOR) |
| POST | `/:id/receive` | **acheteur** + rate-limit ; **déclencheur douane** |
| POST | `/:id/validate` | **acheteur** + **garde douane** (409 `CUSTOMS_REVIEW_PENDING`) |
| POST | `/:id/confirm-receipt` | **acheteur** (404 masquant) — **jumeau de `/validate`** ; garde douane (409 `CUSTOMS_REVIEW_PENDING`) ; garde état strict `AWAITING_VALIDATION` (400 `MISSION_NOT_AWAITING_VALIDATION`) ; escrow HELD check → capture Stripe hors tx (**clé partagée** `capture_<id>`) → `AWAITING_VALIDATION → VALIDATED` (transitoire) ; webhook → ledger PAYOUT/COMMISSION + TransferOutbox + `RELEASED`. Aucun `transfers.create` ni ledger direct |
| POST | `/:id/customs-receipt` | **voyageur** + rate-limit ; verrou → revue |
| POST | `/:id/customs-approve` | **admin** (`isAdmin`) ; escrow HELD check → capture Stripe hors tx (`capture_customs_<id>`) → **[D-c+S4] PENDING_CUSTOMS_REVIEW → VALIDATED + audit atomiques** ; webhook → RELEASED |
| POST | `/:id/customs-reject` | **admin** ; **[D-c] atomique** + alerte post-commit |
| GET | `/api/missions/customs-pending` | **admin** ; file de revue |

### Escrow (JWT, `onRequest: authenticate`)
| Méthode | Route | Garde / note |
|---|---|---|
| POST | `/api/escrow/:missionId/capture` | **[D-a] acheteur** (404 masquant) + **garde douane** (409 `CUSTOMS_LOCK_ACTIVE`) ; délègue à `captureEscrowFunds` (capture Stripe seule, 0 écriture DB) |

### Admin (JWT, `onRequest: authenticate`) — [`src/admin/arbitrage.route.ts`](../src/admin/arbitrage.route.ts)
| Méthode | Route | Garde / note |
|---|---|---|
| POST | `/api/admin/missions/:id/arbitrate-fraud` | **admin** (`isRequestAdmin`, 403 sinon) ; garde état strict `DISPUTED` (400 `MISSION_NOT_DISPUTED`) ; escrow requis (400 `ESCROW_NOT_FOUND`). `$transaction` (**aucun appel Stripe**) : `updateMany` anti-TOCTOU `DISPUTED → DISPUTED_FRAUD` + `PenaltyDebitOutbox` PENDING voyageur (200% de Objet+Frais) + `LedgerEntry` `FRAUD_PENALTY_COLLECTED` (200%) / `BUYER_REFUND_COMPENSATION` (120%) + `AdminAuditLog` `ADMIN_ARBITRATE_FRAUD`. Idempotent (transition unique + `PenaltyDebitOutbox.missionId @unique`). Exécution monétaire **différée** à un worker dédié |

### Stripe (signature `constructEvent`, **JAMAIS** JWT)
| Méthode | Route | Note |
|---|---|---|
| POST | `/api/stripe/issuing-authorization` | secret dédié `STRIPE_ISSUING_WEBHOOK_SECRET` ; JIT < 2 s ; **refus par défaut** (fail-safe) ; 1 lecture indexée (+ jointure statut mission) + comparaison ; **gel** mission `DISPUTED`/`CANCELLED` → `approved:false` (§4) |
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
- **JIT fail-safe** : doute / erreur DB / carte inconnue / escrow non `HELD` / **mission `DISPUTED`
  ou `CANCELLED`** (gel des fonds Sprint 9, contrôle AVANT budget, motif explicite journalisé) → `approved:false`.
- **Hardening voyageur (S13)** ([`mission.route.ts`](../src/missions/mission.route.ts) `travelerHasGuaranteeCard`) :
  `/match` et `/accept` refusent l'assignation (400 `TRAVELER_CARD_MISSING`) si le voyageur n'a pas de
  `stripePaymentMethodId` (carte de garantie vérifiée à l'inscription) — *fail-closed*, lookup DB frais.
  La garde s'applique **après** les checks own-mission/statut (un acheteur ou un statut non-`FUNDED`
  garde sa réponse propre). Cette carte adossera la future ponction de pénalité (moteur 120/200, sprint dédié).
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

> **Types pénalité hors invariants (S14)** : `FRAUD_PENALTY_COLLECTED` et `BUYER_REFUND_COMPENSATION`
> sont **EXCLUS** des sommes A/B/C — `runReconciliation` ne somme que `CAPTURE/PAYOUT/COMMISSION/REFUND`
> ([`reconciliation.ts`](../src/workers/reconciliation.ts) `sumOf`). Ils sont ancrés à l'escrow pour la FK
> mais représentent un **flux séparé** (ponction carte voyageur / compensation acheteur), pas un mouvement
> du séquestre. Magnitudes positives ; le **type** porte la direction. Aucune corruption de l'escrow acheteur.

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
IN_PROGRESS ──/submit-receipt | /drop-off (voyageur, dépôt logistique)──▶ AWAITING_VALIDATION
IN_PROGRESS ──/receive (sous seuil douanier)──▶ VALIDATED (transitoire)
IN_PROGRESS ──/receive (≥ seuil, quittance absente)──▶ ESCROW_LOCKED_CUSTOMS
ESCROW_LOCKED_CUSTOMS ──/customs-receipt (voyageur)──▶ PENDING_CUSTOMS_REVIEW
PENDING_CUSTOMS_REVIEW ──/customs-approve (admin, capture Stripe)──▶ VALIDATED (transitoire)
PENDING_CUSTOMS_REVIEW ──/customs-reject (admin)──▶ ESCROW_LOCKED_CUSTOMS (receipt effacé)
AWAITING_VALIDATION ──/validate | /confirm-receipt (acheteur, capture)──▶ VALIDATED (transitoire)
{MATCHED | VALIDATED} ──/dropoff-receipt (voyageur, preuve de dépôt)──▶ DEPOSITED
DEPOSITED ──/confirm-collection (acheteur, capture Stripe)──▶ VALIDATED (transitoire)
DEPOSITED ──/dispute (acheteur, motif optionnel)──▶ DISPUTED (gel, arbitrage humain)
DISPUTED ──/admin/resolve-refund (admin, cancel PI HELD)──▶ CANCELLED (final)
DISPUTED ──/admin/resolve-payout (admin, capture)──▶ VALIDATED (transitoire)
DISPUTED ──/api/admin/.../arbitrate-fraud (admin, vol voyageur)──▶ DISPUTED_FRAUD (gelé terminal : ponction 200% + compensation 120%)
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

**Arbitrage admin (résolution du gel)** : deux issues exclusives depuis `DISPUTED`, réservées
aux comptes `isAdmin` (`isRequestAdmin`, lookup DB frais — JWT inchangé, identité seule). L'escrow
est toujours `HELD` (litige ouvert depuis `DEPOSITED`, jamais capturé). `/admin/resolve-refund`
(faveur acheteur) → `paymentIntents.cancel` du hold (clé `admin_refund_<id>`, miroir du timeout
douane §6) → `DISPUTED → CANCELLED` (final). `/admin/resolve-payout` (faveur voyageur) →
`paymentIntents.capture` (clé `admin_payout_<id>`) → `DISPUTED → VALIDATED` (transitoire) ; le webhook
finalise en `RELEASED` (même aval que `/confirm-collection`). Décision + `AdminAuditLog` atomiques
(D-c) ; capture/cancel **hors** `$transaction` (règle d'or). Mission non-`DISPUTED` → 400
`MISSION_NOT_DISPUTED` ; escrow non `HELD` → 400 `ESCROW_NOT_HELD`.

**Gel des fonds — enforcement carte JIT (Sprint 9)** : une mission gelée garde son escrow `HELD`
(`DISPUTED` : invariant Sprint 7 ; `CANCELLED` : hold pas encore finalisé). Sans garde, l'autorisation
Issuing temps réel ([`issuing-authorization.route.ts`](../src/stripe/issuing-authorization.route.ts))
approuverait encore la carte (`WITHIN_BUDGET`). La garde lit le statut mission (jointure PK dans la
**même** lecture indexée par `stripeIssuingCardId`) et refuse l'achat **AVANT** le contrôle de budget :
`status ∈ {DISPUTED, CANCELLED}` → `approved:false`, motif `MISSION_DISPUTED`/`MISSION_CANCELLED`
journalisé dans `IssuingAuthorizationLog`. Aucune mutation d'état ni d'argent (webhook synchrone < 2 s,
refus fail-safe). Le gel devient ainsi opposable à la dépense, pas seulement aux libérations.

**Hardening voyageur — carte de garantie (Sprint 13)** : l'acceptation d'une mission (`/match`, `/accept`) exige désormais une carte enregistrée (`User.stripePaymentMethodId`, vérifiée à l'inscription) — sinon 400 `TRAVELER_CARD_MISSING`, aucune assignation. La garde (`travelerHasGuaranteeCard`, lookup DB frais) s'insère **après** les checks own-mission et statut `FUNDED`. Cette carte est la garantie qui adossera la **ponction de pénalité asymétrique 120/200** (débit voyageur 200% / restitution acheteur 120% / marge plateforme 80%) en cas d'arbitrage de fraude. **Décision (vs spec littérale)** : le moteur de pénalité a été **délibérément reporté à un sprint dédié**, car écrire le 120/200 en `LedgerEntry` sur l'escrow acheteur + débit via `TransferOutbox` (comme demandé) **casse plusieurs invariants verrouillés** : (1) restituer 120% = REFUND > Σ(CAPTURE) → viole l'invariant ledger B (§3) et déclenche l'alerte `runReconciliation` ; (2) `LedgerEntry` est ancré sur `escrowId` et `LedgerType` n'a aucun type « pénalité/compensation » ; le débit voyageur n'a aucun escrow ; (3) `TransferOutbox` est un *Connect transfer sortant* (`transfers.create`, clé `@unique` une seule par escrow), pas un débit carte ; (4) `PaymentIntentClient` n'a **aucune** primitive de charge off-session de la carte voyageur. Architecture cible : nouveaux `LedgerType` (`PENALTY_DEBIT`/`COMPENSATION`/`PENALTY_MARGIN`) hors invariant B, table `PenaltyDebitOutbox` + worker de charge dédié, escrow acheteur annulé (miroir `resolve-refund`), maj `reconciliation.ts`. À concevoir avec le PDF « Stratégie de Souveraineté Logistique » (base du calcul, modèle de compte voyageur). **Migration** `20260617130000_add_traveler_stripe_fields` : seule colonne `User.stripePaymentMethodId` (nullable, `@unique`) — `stripeCustomerId` existait déjà (réutilisé côté voyageur).

**Moteur de pénalité 120/200 — arbitrage de fraude (Sprint 14)** : `POST /api/admin/missions/:id/arbitrate-fraud` ([`src/admin/arbitrage.route.ts`](../src/admin/arbitrage.route.ts), nouveau plugin monté sous `/api/admin`) matérialise le moteur reporté en S13, avec la base de calcul fixée : **(budget [Valeur Objet] + commission [Frais Service])**. Réservé aux admins (`isRequestAdmin`, exporté de `mission.route.ts` — source unique). Sur une mission `DISPUTED`, **une seule `$transaction` sans aucun appel Stripe** : transition anti-TOCTOU `DISPUTED → DISPUTED_FRAUD` (gelé terminal) + `PenaltyDebitOutbox` PENDING (ponction voyageur = base × 2 = **200%**) + `LedgerEntry` `FRAUD_PENALTY_COLLECTED` (200%) & `BUYER_REFUND_COMPENSATION` (base × 1,2 = **120%**) + `AdminAuditLog` (D-c). Marge plateforme **80%** implicite (200 − 120). Idempotence : la transition unique + `PenaltyDebitOutbox.missionId @unique` garantissent une seule ponction (double appel → 400 `MISSION_NOT_DISPUTED`, sans doublon). **Décisions (vs spec littérale)** : (1) `LedgerType` réels = `FRAUD_PENALTY_COLLECTED`/`BUYER_REFUND_COMPENSATION` (noms du spec), stockés en **magnitudes positives** (convention `amountCents ≥ 0`, le type porte la direction « +200% / −120% »), **exclus des invariants A/B/C** (cf. §3) — aucune corruption de l'escrow ; (2) ajout de `MissionStatus.DISPUTED_FRAUD` (implicite dans le spec) ; (3) `PenaltyDebitOutbox` enrichi des champs spec (id, userId, amountCents, status, createdAt) + `missionId @unique` (idempotence) + `onDelete: Cascade` (isolation tests, miroir `Review`) + `updatedAt`/relations/index (cycle outbox du futur worker) ; (4) `AdminAuditLog` ajouté (invariant D-c — toute décision admin est tracée) ; (5) **aucun mouvement d'argent dans ce sprint** : la route journalise l'intention (outbox) + le ledger et gèle la mission ; l'EXÉCUTION Stripe (débit carte voyageur, sortie du hold acheteur, versement de la compensation) relève d'un **worker dédié non encore implémenté** — l'escrow reste `HELD`, règle d'or trivialement respectée. **Migration** `20260617140000_add_fraud_penalty_engine` (enum `ADD VALUE` ×3 + table `PenaltyDebitOutbox`).

**Confirmation de réception (Sprint 12)** : `POST /:id/confirm-receipt` est le **jumeau architectural de `/validate`** — même état d'entrée (`AWAITING_VALIDATION`), même effet (déclenche la capture, jamais le versement). Acheteur uniquement (`findMissionForBuyer` → 404 masquant), garde douane (409 `CUSTOMS_REVIEW_PENDING`), garde état strict (400 `MISSION_NOT_AWAITING_VALIDATION`), escrow `HELD` requis (400 `ESCROW_NOT_HELD`). Capture **hors tx** via la **clé partagée** `capture_<missionId>` (un acheteur appelant `/validate` ET `/confirm-receipt` ne capture qu'une fois — idempotence Stripe déterministe). `$transaction` = unique `updateMany` conditionnel `AWAITING_VALIDATION → VALIDATED` (anti-TOCTOU). Le webhook `payment_intent.succeeded` porte **seul** le ledger PAYOUT/COMMISSION, le `TransferOutbox` et `RELEASED` — jamais dupliqués dans la route. **Décision (vs spec littérale)** : la spec demandait ledger PAYOUT/COMMISSION + `transfers.create` + `RELEASED` dans la route ; refusé car cela viole la règle d'or (§5), double les écritures du webhook et casse l'invariant ledger B (PAYOUT/COMMISSION sans CAPTURE à `AWAITING_VALIDATION`). Aucune modif `schema.prisma`.

**Dépôt logistique asynchrone (Sprint 11)** : `POST /:id/drop-off` permet au voyageur de signaler qu'il a confié le colis à un réseau tiers (casier `LOCKER`, point relais `RELAY`, poste `POSTAL`). Réservé au voyageur assigné (404 masquant invariant IDOR). Transition atomique anti-TOCTOU `IN_PROGRESS → AWAITING_VALIDATION` dans `$transaction` avec `updateMany({ where: { status: IN_PROGRESS } })`. Champs `dropOffType` (enum `DropOffType`), `dropOffCarrier`, `dropOffTrackingId`, `dropOffAccessCode?` et `droppedAt` (horodatage serveur) scellés à la transition. Aucun appel Stripe.

**Notation post-clôture (Sprint 10)** : `POST /:id/reviews` permet à chaque participant (buyer et traveler, séparément) de noter l'autre partie après clôture (`RELEASED` ou `CANCELLED`). Gardes dans `$transaction` : `findMissionForParticipant(tx, id, userId)` (404 masquant si tiers) + check statut terminal (400 `MISSION_NOT_TERMINAL`) + dérivation `targetId` (l'autre partie). Doublon absorbé par `@@unique([missionId, authorId])` → 409 `REVIEW_ALREADY_SUBMITTED`. `onDelete: Cascade` sur `Review.missionId` garantit la cohérence si une mission est supprimée (tests + production). Aucun appel Stripe, aucune écriture ledger.

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
   | `capture_<missionId>` | `paymentIntents.capture` (T1) | `/validate`, `/confirm-receipt` (jumeau, clé partagée), `/receive`, `captureEscrowFunds` |
   | `capture_customs_<missionId>` | `paymentIntents.capture` (T1-douane) | `/customs-approve` — chemin admin, distinct du chemin buyer |
   | `capture_collection_<missionId>` | `paymentIntents.capture` (T1-collecte) | `/confirm-collection` — chemin acheteur depuis `DEPOSITED` ; le transfert aval réutilise `transfer_marchand_<id>` (webhook → outbox → worker) |
   | `timeout_collection_<missionId>` | `paymentIntents.capture` (T1-timeout) | `runReconciliation` §7 — auto-libération si `DEPOSITED` > 5 j (acheteur inactif) ; même aval que la collecte manuelle |
   | `admin_refund_<missionId>` | `paymentIntents.cancel` (arbitrage) | `/admin/resolve-refund` — annule le hold HELD d'une mission `DISPUTED` (faveur acheteur, miroir du timeout douane) |
   | `admin_payout_<missionId>` | `paymentIntents.capture` (arbitrage) | `/admin/resolve-payout` — capture le hold HELD d'une mission `DISPUTED` (faveur voyageur) ; même aval webhook que la collecte |
   | `refund_customs_<missionId>` | `paymentIntents.cancel` (timeout) | worker `runReconciliation` section 6 (SLA > 7 j) |
   | `transfer_marchand_<missionId>` | `transfers.create` (T4) | `handleCapture` → réutilisée telle quelle par le worker |

3. **Contraintes `@unique` DB** : `EscrowTransaction.{missionId, stripePaymentIntentId,
   idempotencyKey (escrow_fund_<missionId>), stripeIssuingCardId}` ;
   `TransferOutbox.{idempotencyKey, stripeTransferId}` ;
   `PenaltyDebitOutbox.missionId` (une seule ponction de fraude par mission) ;
   `IssuingAuthorizationLog.stripeAuthorizationId` ; `Receipt.missionId` ;
   `ProcessedStripeEvent.stripeEventId` ; `User.stripePaymentMethodId`.
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

### Sprint 8 — Arbitrage admin litige (`resolve-refund` / `resolve-payout`)
- **Route** [`mission.route.ts`](../src/missions/mission.route.ts) : deux routes admin résolvant une
  mission `DISPUTED`, gardées par `isRequestAdmin` (lookup DB frais ; **JWT inchangé** — décision
  d'archi §2 préservée, pas de rôle dans le jeton). Garde d'état strict `DISPUTED` (400
  `MISSION_NOT_DISPUTED`) + précondition escrow `HELD` (400 `ESCROW_NOT_HELD`).
  - `resolve-refund` (faveur acheteur) : `paymentIntents.cancel` **hors tx** (`admin_refund_<id>`)
    → `$transaction(DISPUTED → CANCELLED + AdminAuditLog ADMIN_RESOLVE_REFUND)`. Annule le hold
    jamais capturé (≠ `refunds.create` : rien à rembourser) — miroir du timeout douane §6.
  - `resolve-payout` (faveur voyageur) : `paymentIntents.capture` **hors tx** (`admin_payout_<id>`)
    → `$transaction(DISPUTED → VALIDATED + AdminAuditLog ADMIN_RESOLVE_PAYOUT)` ; webhook finalise
    → `RELEASED` (même aval que `/confirm-collection`, aucun ledger/transfer inline).
  - Surface Stripe : `cancel?` ajouté à `PaymentIntentClient` (optionnel comme `checkout?`, signature
    3-arg = SDK réel : idempotencyKey en options). Décision + audit atomiques (D-c).
  > **Décisions (vs spec littérale)** : (1) garde RBAC via `isRequestAdmin` existant, **pas** d'ajout
  > `isAdmin` au JWT (régression de sécurité : jeton 12 h ⇒ admin révoqué actif jusqu'à expiration ;
  > le lookup DB révoque à chaud) ; (2) refund = `paymentIntents.cancel` (hold HELD non capturé), pas
  > `refunds.create` ; (3) `AdminAuditLog` tracé dans la `$transaction` (invariant D-c, comme
  > `customs-approve/reject`). Test : `admin-dispute.test.ts` (happy paths, 403/401, 400, idempotence).

**État de validation global** : `npx tsc --noEmit` → 0 erreur ; `npx vitest run` → **28 fichiers,
153 tests verts** (+3 arbitrage fraude). Fichiers Sprint 14 : `schema.prisma` (enums `MissionStatus.DISPUTED_FRAUD`,
`LedgerType.FRAUD_PENALTY_COLLECTED`/`BUYER_REFUND_COMPENSATION` + modèle `PenaltyDebitOutbox`),
`src/admin/arbitrage.route.ts` (nouveau), `src/app.ts` (montage `/api/admin`), `mission.route.ts` (`export isRequestAdmin`),
`admin-arbitrage-fraud.test.ts` (nouveau), ce fichier. Migration `20260617140000_add_fraud_penalty_engine`.
**Worker d'exécution de la ponction (charge carte voyageur + compensation acheteur) : non encore implémenté** (voir §4).

> Sprint 13 (rappel) : hardening voyageur (`User.stripePaymentMethodId` requis sur `/match` et `/accept`,
> 400 `TRAVELER_CARD_MISSING`). Migration `20260617130000_add_traveler_stripe_fields`.
