# Waylo — RLS Hardening & Runbook de bascule

## Architecture RLS (Row-Level Security)

### Couches de sécurité

```
Requête HTTP
  └─ JWT (Fastify/authenticate)          ← couche 1 : identité
      └─ Autorisation applicative        ← couche 2 : findMissionForBuyer/Participant
          └─ RLS PostgreSQL              ← couche 3 : défense en profondeur DB
```

La couche 3 (RLS) **double** la couche 2 sans la remplacer. En cas de régression applicative,
la DB refuse la requête. Les deux couches partagent la même logique d'autorisation (miroir exact).

### Rôles

- **`postgres`** — propriétaire des tables/policies, utilisé pour les migrations (`directUrl`
  Prisma). `BYPASSRLS=true` (fourni par Supabase, non modifiable — pas de droit superuser).
  N'est **jamais** utilisé comme rôle runtime applicatif.
- **`waylo_user`** — rôle de connexion runtime (`url` Prisma), `LOGIN NOBYPASSRLS NOSUPERUSER`.
  Les politiques RLS s'appliquent réellement à ce rôle. Grants CRUD explicites sur les tables
  (pas de `BYPASSRLS`, donc aucune fuite possible même si une policy est mal écrite ailleurs).
- **`waylo_app` / `SET LOCAL ROLE`** — ❌ **abandonné**. `GRANT waylo_app TO postgres WITH SET TRUE`
  provoque une coupure de session sur Supabase (auto-modification du rôle réservé `postgres`).
  Toute référence à ce mécanisme dans du code ou de la doc antérieure est obsolète.

### États du déploiement

Le bypass n'est plus porté par le rôle de connexion (impossible sans superuser sur Supabase) mais
par une clause dans les policies elles-mêmes : `current_setting('app.bypass_rls', true) IS DISTINCT
FROM 'off'` — GUC absent ou `'on'` ⇒ bypass ; `'off'` (posé explicitement par `withRlsContext` en
mode `enforce`) ⇒ policies pleinement actives.

| Flag DB (`FeatureFlag.mode`) | `app.bypass_rls` (GUC) | RLS active | Objectif |
|---|---|---|---|
| `off`     | `on`  | ✗ (bypass) | État initial + cible kill switch |
| `shadow`  | `on`  | ✗ (bypass) | Mesure d'écarts sans risque |
| `enforce` | `off` | ✓          | Production durcie |

---

## Runbook — Bascule runtime `postgres` → `waylo_user`

### État actuel (2026-07-01)

- ✅ Rôle `waylo_user` déployé en prod (migration `20260701140000_create_waylo_user`).
- ✅ Policies avec clause de bypass par défaut déployées (migration `20260701150000_rls_bypass_default`).
- ✅ `prisma/schema.prisma` sépare `url` (runtime) et `directUrl` (migrations).
- 🟡 **Le runtime de production tourne toujours sur `postgres`.** Tant que `DATABASE_URL` n'a pas
  été basculé vers `waylo_user`, la RLS reste inerte quel que soit l'état des flags — `postgres`
  est `BYPASSRLS` et ignore toutes les policies inconditionnellement.

### Prérequis avant bascule du `DATABASE_URL` de prod

- [x] Migrations `20260630130000` (policies par identité) et `20260701150000` (bypass par défaut) en prod
- [x] Rôle `waylo_user` créé et testé (`SET ROLE waylo_user` : bare=voit, enforce sans identité=0, propriétaire=1, tiers=0)
- [ ] Flags `rls.missions` et `rls.wallets` en `shadow` pendant ≥ 1 cycle complet
- [ ] `rls_shadow_mismatch_total` = 0 stable sous trafic réel (`GET /debug/metrics`)
- [ ] Tests d'isolation (`src/security/rls-isolation.test.ts`) verts sur la branche

### Bascule `DATABASE_URL` vers `waylo_user`

Le mot de passe `waylo_user` est défini en base (`ALTER ROLE waylo_user WITH PASSWORD '...'`).
Construire la nouvelle URL en remplaçant `postgres:<mot_de_passe>` par `waylo_user:<mot_de_passe>` —
**uniquement sur `DATABASE_URL`** (`url` Prisma). `DIRECT_URL` reste sur `postgres` (migrations).

```bash
fly secrets set DATABASE_URL="postgresql://waylo_user:<pwd>@db.<ref>.supabase.co:5432/postgres?connection_limit=5"

# Vérification (attendre le redéploiement)
curl -H "Authorization: Bearer <admin_jwt>" https://<app>.fly.dev/debug/metrics
```

---

## Kill Switch — 3 niveaux (du plus rapide au plus fort)

### Niveau 1 — Flag applicatif (< 5 s, sans redémarrage)

```typescript
// Via console Node.js ou route admin interne
import { FeatureGuard } from './src/lib/feature-guard'
await FeatureGuard.kill('rls.missions', adminId)
await FeatureGuard.kill('rls.wallets',  adminId)
// Effet : mode → 'off', bypass_rls='on', cache évincé immédiatement
```

### Niveau 2 — SQL direct (< 1 min, sans code)

```sql
-- Via Dashboard Supabase → SQL Editor
UPDATE "FeatureFlag" SET mode = 'off', "updatedAt" = NOW()
WHERE key IN ('rls.missions', 'rls.wallets');
```

Le cache `FeatureGuard` expire en < 5 s → effet sans redémarrage.

### Niveau 3 — Bascule DATABASE_URL (< 2 min, revient à `postgres` BYPASSRLS)

```bash
fly secrets set DATABASE_URL="postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres?connection_limit=5"
```

Fly redéploie automatiquement. Le rôle `postgres` est `BYPASSRLS` → toutes les
politiques RLS sont ignorées inconditionnellement. **Option nucléaire** : aucun risque
de régression applicative, les politiques restent en place pour la reprise.

---

## Observabilité — `GET /debug/metrics` (admin JWT requis)

```json
{
  "collectedAt": "2026-06-30T14:00:00.000Z",
  "counters": {
    "rls_shadow_mismatch_total": { "value": 0, "help": "..." },
    "rls_enforce_reject_total":  { "value": 0, "help": "..." },
    "escrow_capture_customs_lock_collision_total": { "value": 3, "help": "..." },
    "circuit_breaker_escrow_capture_opened_total": { "value": 0, "help": "..." }
  },
  "histograms": {
    "funding_verified_auth_cents": { "count": 47, "p50": 11500, "p95": 22000, "max": 95000 }
  }
}
```

**Critère de passage `shadow` → `enforce`** : `rls_shadow_mismatch_total` = 0
sous trafic réel pendant ≥ 24 h (un cycle complet création→financement→capture→litige).

---

## Rollback complet (si enforce génère des régressions)

```sql
-- 1. Kill switch flag (niveau 2, immédiat)
UPDATE "FeatureFlag" SET mode = 'off', "updatedAt" = NOW()
WHERE key IN ('rls.missions', 'rls.wallets');

-- 2. (Optionnel) Désactiver les politiques
ALTER TABLE "Mission" DISABLE ROW LEVEL SECURITY;
ALTER TABLE "Wallet"  DISABLE ROW LEVEL SECURITY;

-- 3. (Si DATABASE_URL = waylo_user) Revenir à postgres via fly secrets set (Niveau 3)
```

Aucune politique n'est droppée — rollback est une opération de configuration, pas de DDL.
