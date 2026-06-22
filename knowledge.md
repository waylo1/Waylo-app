# Waylo — knowledge.md
> Source de vérité unique. Généré le 2026-06-22. Ne pas modifier manuellement.

---

## Stack verrouillée

| Couche | Technologie | Version |
|---|---|---|
| Backend | Fastify + TypeScript strict | Fastify 5 |
| DB | PostgreSQL via Supabase EU | — |
| ORM | Prisma (client dans `src/generated/prisma`) | 5.22.0 |
| Paiements | Stripe — PaymentIntent capture différée | SDK 17 |
| Cartes d'achat | Stripe Issuing JIT (Option B) | — |
| Vision/OCR | Anthropic SDK — Claude Haiku | 0.105.0 |
| Tests | Vitest 2 — DB `waylo_test`, séquentiel | — |
| Frontend | Next.js 16, React 19, Tailwind 4, Base UI | — |

**Déploiement :** Fly.io (`fly.toml`), Docker (`Dockerfile`).
**Frontend :** port 3001, proxy `/api → :3000`.

---

## System Capabilities

- **Dispute Resolution:** Automated 72h refund flow + 150€ abusive contest penalty (Atomic Penalty Outbox).

---

## Architecture des modules

### Backend (`src/`)

| Module | Chemin | Rôle |
|---|---|---|
| App factory | `src/app.ts` | Registre Fastify, plugins, routes |
| Serveur + workers | `src/server.ts` | Point d'entrée, démarrage de tous les workers |
| Prisma singleton | `src/db.ts` | Instance globale + guard immutabilité escrow |
| Auth | `src/auth/` | JWT + Argon2, cookie HttpOnly, `authenticate` preHandler |
| Missions | `src/missions/` | Cycle de vie complet — sous-routeurs par thème |
| Escrow | `src/escrow/` | Routes escrow (consultation, transition) |
| Receipts | `src/receipts/` | Upload image → `ReceiptExtractionOutbox` |
| Stripe webhooks | `src/stripe/webhook.route.ts` | `payment_intent.succeeded`, `charge.refunded` |
| Stripe Issuing JIT | `src/stripe/issuing-authorization.route.ts` | Auth temps-réel < 2 s, secret distinct |
| Services | `src/services/` | `DisputeService`, `sealReceipt()`, `AnthropicVisionClient` |
| Workers | `src/workers/` | 12 boucles polling — voir tableau ci-dessous |
| Monitoring | `src/monitoring/` | Métriques OutboxEvent (health check) |
| Rate limiter | `src/rate-limit.ts` | Token bucket PostgreSQL, fenêtre fixe |
| Alertes | `src/alerts.ts` | NDJSON + Slack webhook |
| Admin | `src/admin/` | Routes arbitrage fraude (admin only) |
| Wallet | `src/checkout/` | Validation wallet acheteur |

### Frontend (`frontend/`)

| Dossier | Contenu |
|---|---|
| `app/login/` | Page connexion |
| `app/missions/` | Liste + détail missions |
| `app/profile/` | Profil utilisateur |
| `app/cgu/` | Conditions générales |
| `components/` | Composants réutilisables (Base UI + Tailwind) |

---

## Modèles Prisma

### Modèles principaux (17 au total)

**Utilisateurs**
- `User` — email, passwordHash, isAdmin, kycStatus, stripeCustomerId, stripeAccountId, stripePaymentMethodId
- Enums : `AccountStatus` (ACTIVE | SUSPENDED), `KycStatus` (PENDING | VERIFIED | REJECTED)

**Mission (23 statuts)**
```
CREATED → FUNDED → MATCHED → IN_PROGRESS
  → ESCROW_LOCKED_CUSTOMS → PENDING_CUSTOMS_REVIEW
  → AWAITING_VALIDATION → VALIDATED → DEPOSITED
  → AWAITING_CONFIRMATION → COMPLETED_BY_BUYER
  → RELEASED → REFUNDED
  ↳ DISPUTED (arbitrage humain, modèle Dispute)
  ↳ IN_DISPUTE (auto-refund 72h, OutboxEvent READY_FOR_REFUND)
  ↳ DISPUTED_FRAUD
  ↳ AWAITING_TRAVELER_ACCOUNT | CANCELLED | EXPIRED
```
- `DropOffType` : LOCKER | RELAY | POSTAL

**Escrow & Ledger (append-only)**
- `EscrowTransaction` — missionId @unique, stripePaymentIntentId @unique, capturedAmountCents, status
- `EscrowStatus` : HELD | RELEASED | REFUNDED | PARTIALLY_REFUNDED | CANCELLED
- `LedgerEntry` — type : CAPTURE | PAYOUT | COMMISSION | REFUND | BUYER_WALLET_CREDIT | FRAUD_PENALTY_COLLECTED | BUYER_REFUND_COMPENSATION
- **Invariant A :** Σ(CAPTURE) = capturedAmountCents
- **Invariant B :** Σ(PAYOUT+COMMISSION+REFUND+WALLET_CREDIT) ≤ Σ(CAPTURE)
- **Invariant C :** si RELEASED → égalité stricte

**Outbox tables**

| Table | Trigger | Worker | Transition |
|---|---|---|---|
| `TransferOutbox` | payment_intent.succeeded | transfer-worker | PENDING→SUBMITTED→SETTLED\|FAILED\|ABANDONED |
| `PenaltyDebitOutbox` | décision arbitrage | penalty.worker | idem |
| `BuyerCompensationOutbox` | fraude résolue | buyer-compensation.worker | PENDING→SETTLED\|FAILED |
| `ReceiptExtractionOutbox` | upload reçu | receiptOutboxWorker | PENDING→PROCESSING→COMPLETED\|FAILED→CONSUMED |
| `OutboxEvent` | routes diverses | escrowPayoutWorker / disputeResolutionWorker | PENDING→SETTLED\|FAILED |

**Dispute & Pénalité**
- `Dispute` — missionId @unique, idempotencyKey @unique, status : DRAFT→OPEN→ESCALATED→RESOLVED→CLOSED
- `Penalty` — missionId @unique, amountCents=15000 fixe, reason=ABUSIVE_DISPUTE, status : PENDING\|PAID\|FAILED

**Autres**
- `Receipt` — missionId @unique, sha256Client, sha256Server, sealedAt (immutable)
- `Wallet` — userId @unique, balanceCents
- `WalletTransaction` — missionId @unique, reason=SUBSTITUTION_RESIDUAL
- `SubstitutionRequest` — PENDING\|APPROVED\|REJECTED\|ITEM_SKIPPED
- `Review` — @@unique[missionId, authorId], rating 1-5
- `IssuingAuthorizationLog` — stripeAuthorizationId @unique, APPROVED\|DECLINED (audit immutable)
- `ProcessedStripeEvent` — stripeEventId @unique (dedup webhook)
- `AdminAuditLog` — append-only
- `RateLimit` — key @id, count, expiresAt

---

## Workers (12 boucles)

| Worker | Cadence | Rôle |
|---|---|---|
| `transfer-worker.ts` | ~60 s | Virements Stripe → TransferOutbox |
| `penalty.worker.ts` | ~60 s | Débit fraude hors session (200%) |
| `buyer-compensation.worker.ts` | ~60 s | Crédit acheteur 120% |
| `receiptOutboxWorker.ts` | ~60 s | OCR Vision → scellement |
| `escrowPayoutWorker.ts` | ~60 s | Capture RELEASED → OutboxEvent READY_FOR_PAYOUT |
| `disputeResolutionWorker.ts` | ~60 s | Refund auto 72h + pénalité → OutboxEvent READY_FOR_REFUND |
| `disputePenaltyWorker.ts` | ~60 s | Charge pénalité dispute abusive, FAILED → SUSPENDED |
| `funding-reconciliation.ts` | 15 min | Annule PaymentIntents orphelins |
| `reconciliation.ts` | Daily (delay 15 min) | Vérification invariants ledger ↔ Stripe |
| `rate-limit-cleanup.ts` | 1 h | Purge compteurs expirés |
| `mission-lifecycle.ts` | 1 h | CREATED → EXPIRED après deadline |
| `keep-alive.ts` | 20 min | SELECT 1 anti-pause Supabase |
| `workerHealth.ts` | 5 min | Métriques OutboxEvent (monitoring only) |

**Pattern :** `SELECT … FOR UPDATE SKIP LOCKED` → traitement hors transaction → update statut.
Jamais d'appel Stripe dans une transaction Prisma.

---

## Conventions critiques

| Règle | Détail |
|---|---|
| **Argent** | Centimes `Int` partout. `centsToEur()` / `eurToCents()`. Jamais Float. |
| **Atomicité financière** | `prisma.$transaction()` + transition conditionnelle `WHERE status = FROM_STATE` (anti-TOCTOU) |
| **TypeScript** | `strict: true`, zéro `any`. Enums TS = miroir exact enums Prisma. |
| **Auth routes** | JWT obligatoire sauf `/health`. Erreurs : `{ error: 'SNAKE_CASE_CODE' }` |
| **Reçus** | sha256 client + serveur obligatoires. Scellement = immutable. |
| **Webhook dedup** | `ProcessedStripeEvent` — toujours vérifier avant traitement. |
| **JIT < 2 s** | `issuing_authorization.request` — endpoint séparé, secret distinct, pas de I/O lourd. |
| **Pas de chat** | Aucune messagerie libre. Interactions = choix structurés uniquement. |
| **Validation humaine** | Obligatoire aux points de décision (substitution, capture des fonds, arbitrage). |

---

## Deux systèmes de litige — NE PAS CONFONDRE

| | `DISPUTED` | `IN_DISPUTE` |
|---|---|---|
| Modèle | `Dispute` (arbitrage humain) | `OutboxEvent` READY_FOR_REFUND |
| Déclenchement | Admin / route dispute structurée | Route dispute automatique |
| Résolution | Décision admin → `RESOLVED` | Auto-refund à 72h via `disputeResolutionWorker` |
| `openDispute` | Fonction distincte #1 | Fonction distincte #2 |

---

## Variables d'environnement

**Obligatoires (fail-fast au démarrage) :**
```
DATABASE_URL
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_ISSUING_WEBHOOK_SECRET
JWT_SECRET
```

**Optionnelles :**
```
SUPABASE_URL / SUPABASE_ANON_KEY
WAYLO_CRITICAL_ALERTS_FILE   (défaut: alerts-critical.ndjson)
WAYLO_ALERT_WEBHOOK_URL      (Slack webhook)
DATABASE_CONNECTION_LIMIT    (défaut: 5)
RATE_LIMIT_MAX               (override test: 1000000)
```

**Frontend (`.env.local`) :**
```
NEXT_PUBLIC_API_BASE
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
```

---

## Tests

**Runner :** Vitest 2, séquentiel (`fileParallelism: false`), DB dédiée `waylo_test`.
**Setup global :** `src/test-global-setup.ts` — migrations avant suite, purge tables `beforeAll`.
**Localisation :** fichiers `*.test.ts` co-localisés avec la source.

```bash
npm test               # vitest run (tous les tests)
npm run typecheck      # tsc --noEmit (zéro erreur obligatoire)
```

**DB test locale :** `flipsync-pg:5433` (s'arrête en idle — relancer si connexion refusée).

---

## Routes clés

| Endpoint | Méthode | Rôle |
|---|---|---|
| `/api/auth/register` | POST | Création compte |
| `/api/auth/login` | POST | Login → JWT + cookie HttpOnly |
| `/api/missions` | POST | Créer mission (acheteur) |
| `/api/missions/available` | GET | Missions financées (voyageur) |
| `/api/missions/:id/intent` | POST | Initier financement (PaymentIntent) |
| `/api/missions/:id/ship` | POST | Départ voyageur, pose `purchaseAmountCents` |
| `/api/missions/:id/confirm-collection` | POST | Scan QR intérieur + scellement (sans capture) |
| `/api/missions/:id/confirm-receipt` | POST | Acheteur confirme → capture + payout |
| `/api/missions/:id/dispute` | POST | Ouvre litige |
| `/api/stripe/webhook` | POST | Webhook async Stripe |
| `/api/stripe/issuing-authorization` | POST | JIT auth < 2 s |
| `/api/receipts/upload` | POST | Upload reçu → outbox OCR |

---

## Alertes — codes critiques

**CRITICAL (bloquant ops) :** LEDGER_INVARIANT_BROKEN, CAPTURE_WITHOUT_LEDGER, ORPHAN_TRANSFER, TRANSFER_MISSING_ON_STRIPE, AUTHORIZATION_WITHOUT_CAPTURE, WEBHOOK_ABORT_NON_RECOVERABLE, TRANSFER_ABANDONED, RECONCILIATION_RUN_FAILED, CUSTOMS_LOCK_CAPTURED, COLLECTION_TIMEOUT_CAPTURE_FAILED, MISSION_DISPUTED_BY_BUYER, PENALTY_DEBIT_ABANDONED, DISPUTE_PENALTY_ACCOUNT_SUSPENDED, RECEIPT_INTEGRITY_VIOLATION

**Sink :** NDJSON append-only + Slack webhook (best-effort, pas de retry).

---

## Scripts utiles

```bash
npm run dev                           # Backend dev (tsx watch)
npm run migrate:dev                   # Migration Prisma dev
npm run migrate:deploy                # Migration prod (CI/CD)
npm run reconcile                     # Déclenche réconciliation manuelle
cd frontend && npm run dev            # Frontend :3001
npx stripe listen --forward-to ...   # Stripe CLI webhooks local
tsx scripts/e2e-smoke.mts            # Smoke test E2E
```
