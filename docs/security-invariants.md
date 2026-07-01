# Invariants de sécurité — Waylo backend

> Dernière mise à jour : 2026-07-01 (branche `feature/delivery-pod`).

---

## ⚠️ DÉCLARATION D'INTENTION (WIP) — Cible vs Réalité

RLS est **en transition**, pas en régime stable. Ce document mélange du déployé,
du prêt-mais-pas-déployé, et de la cible. Ne rien supposer « en production » sans
vérifier la colonne Statut ci-dessous.

| Élément | Statut réel (2026-07-01) |
|---|---|
| Politiques granulaires identité (`20260630130000` + défaut bypass `20260701150000`) | ✅ **Déployées sur prod.** `deny_all` supprimé ; `mission_*`/`wallet_*` par identité ; clause d'échappement `app.bypass_rls IS DISTINCT FROM 'off'` (GUC absent ⇒ bypass, continuité des chemins nus) |
| Rôle runtime `waylo_user` (NOBYPASSRLS, LOGIN) — `20260701140000` | ✅ **Déployé sur prod** (rolbypassrls=false, non-superuser, grants CRUD). **Enforcement réel prouvé** (psql `SET ROLE waylo_user` : bare=voit, enforce sans identité=0, propriétaire=1, tiers=0) |
| Rôle `waylo_app` + `SET LOCAL ROLE` | ❌ **Abandonnés.** `GRANT waylo_app TO postgres WITH SET TRUE` coupe la session Supabase (auto-modif du rôle réservé) ; migration `20260701130000` neutralisée en no-op |
| `src/lib/rls-context.ts` | ✅ Plus de `SET LOCAL ROLE` ; enforcement = rôle `waylo_user` NOBYPASSRLS + GUC `app.bypass_rls` (`is_local` : off=enforce / on=bypass) |
| Kill-switch `FeatureGuard` **branché** | ✅ `withRlsContext` dérive le bypass de `FeatureGuard.mode(flagKey)` (`rls.missions`/`rls.wallets`) — off/shadow ⇒ `bypass_rls='on'`, enforce ⇒ `'off'`. Flags **`off`** en prod. `kill()` propage < 5 s |
| Séparation Migrations/Runtime (`directUrl`) | ✅ `schema.prisma` : `url`=runtime (`waylo_user`), `directUrl`=migrations (`postgres`). Test-harness fait défaut `DIRECT_URL`→`DATABASE_URL` |
| Bascule runtime → `waylo_user` (secrets GitHub) | 🟡 **En attente** : mot de passe `waylo_user` + rotation `DATABASE_URL`/`DIRECT_URL` + redéploiement + flags `shadow`→`enforce`. Tant que le runtime reste `postgres` (BYPASSRLS), la RLS est inerte quel que soit le flag |
| Câblage — **routes financières** (funding, capture/logistics, dispute, admin) | ❌ **Exclu intentionnellement.** Restent sur `prisma` nu (bypass par défaut via policy) — `withRlsContext` ouvre une `$transaction`, incompatible avec « aucun appel Stripe dans une `$transaction` » (§3) |
| `src/rls-security.test.ts` | ❌ N'existe pas — le réel est [`src/security/rls-isolation.test.ts`](../src/security/rls-isolation.test.ts) (app-layer, 9/9) |

**Auth réelle** : JWT maison (`app.jwt.sign({ sub })`, argon2) — **PAS** Supabase Auth.
Conséquence : `auth.uid()` est **inopérant** ici (toujours NULL). Toute politique
DOIT utiliser le GUC applicatif `current_setting('app.current_user_id')`, jamais
`auth.uid()`.

> Les sections numérotées ci-dessous restent la **spécification cible**. Les écarts
> connus sont listés dans le tableau ci-dessus.

---

## 1. RLS Enforcement via `waylo_app` role

### Principe

PostgreSQL Row Level Security (RLS) avec `FORCE ROW LEVEL SECURITY` n'est **pas suffisant** si
la connexion de pool démarre en rôle `BYPASSRLS=true` (ex. `flipsync` / `postgres`).
La parade : basculer le rôle de la **transaction** via `SET LOCAL ROLE waylo_app` (`NOBYPASSRLS`).

`SET LOCAL` est transaction-safe : le rôle revient automatiquement au rôle de connexion au
`COMMIT` ou `ROLLBACK` — aucun risque de pollution inter-requêtes sur le pool.

### Implémentation

Fichier : [`src/lib/rls-context.ts`](../src/lib/rls-context.ts)

```typescript
export async function withRlsContext<T>(ctx: RlsContext, fn: (tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    if (!ctx.bypass) {
      await tx.$executeRawUnsafe('SET LOCAL ROLE waylo_app')  // NOBYPASSRLS
    }
    await tx.$executeRaw`
      SELECT
        set_config('app.current_user_id', ${ctx.userId ?? ''}, true),
        set_config('app.is_admin',        ${ctx.isAdmin  ? 'on' : 'off'}, true),
        set_config('app.is_service',      ${ctx.isService ? 'on' : 'off'}, true),
        set_config('app.bypass_rls',      ${ctx.bypass    ? 'on' : 'off'}, true)
    `
    return fn(tx)
  })
}
```

| `bypass` | Rôle de transaction | Politiques RLS | Usage |
|---|---|---|---|
| `false` | `waylo_app` (NOBYPASSRLS) | **actives** | mode `enforce` |
| `true` | rôle de connexion (BYPASSRLS) | inactives | mode `off` / `shadow` |

### Activation progressive (FeatureGuard)

```
off     → shadow  → enforce
         (logs)    (SET LOCAL ROLE actif)
```

- `shadow` : les GUC sont posés, `bypass=true` → politiques inactives, mais métriques `rls_shadow_mismatch_total` accumulées.
- `enforce` : `bypass=false` → `SET LOCAL ROLE waylo_app` actif à chaque transaction.
- Kill switch : `FeatureGuard.kill('rls.missions', adminId)` — propagation < 5 s.

### Prérequis de déploiement

Chaque nouveau déploiement / migration Supabase doit exécuter :

```sql
-- 1. Créer le rôle (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waylo_app') THEN
    CREATE ROLE waylo_app NOLOGIN NOBYPASSRLS NOSUPERUSER INHERIT;
  END IF;
END $$;

-- 2. USAGE sur le schéma (OBLIGATOIRE — sans ça : "permission denied for schema public")
GRANT USAGE ON SCHEMA public TO waylo_app;

-- 3. Grants tables + séquences
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO waylo_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO waylo_app;

-- 4. Default privileges (futures tables Prisma)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO waylo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO waylo_app;
```

> Script complet : [`prisma/migrations/20260630160000_setup_waylo_app/migration.sql`](../prisma/migrations/20260630160000_setup_waylo_app/migration.sql)
> Migration Prisma standard — appliquée via `prisma migrate deploy` comme les autres (vérifié sur `waylo_test`, pas encore sur prod).

### Tests de régression

Fichier : [`src/rls-security.test.ts`](../src/rls-security.test.ts)

| Test | Ce qu'il vérifie |
|---|---|
| (A) unauthenticated | `userId=''` → voit uniquement missions FUNDED sans voyageur |
| (B1) cross-user Mission | userB ne voit pas la mission CREATED de userA |
| (B2) own Mission | userA voit sa propre mission |
| (C1) IDOR Wallet | userB ne peut pas lire le wallet de userA |
| (C2) own Wallet | userA voit son propre wallet |
| (D1) bypass=true | toutes les missions visibles (mode off/shadow) |
| (D2) bypass=false | isolation enforce, pas de fuite cross-user |
| HTTP 401 | GET /api/missions/:id sans JWT → 401 |
| HTTP 404 | GET /api/missions/:id avec token userB → 404 (IDOR bloqué) |

---

## 2. Escrow anti-TOCTOU (CAS atomique)

Toute écriture financière utilise `prisma.$transaction()` avec verrouillage conditionnel (Compare-And-Swap) :

```typescript
const updated = await prisma.escrowTransaction.updateMany({
  where: { id, status: 'HELD' },   // précondition atomique
  data:  { status: 'CAPTURED' },
})
if (updated.count === 0) throw new AppError('CONCURRENT_MODIFICATION', 409)
```

Références : [`src/lib/rls-context.ts`](../src/lib/rls-context.ts), commit `46d8f20`.

---

## 3. Stripe Issuing JIT — décision temps réel

Chaque autorisation carte est approuvée/refusée en < 2 s dans `issuing_authorization.request` :

```
EscrowTransaction.status === 'HELD'
  AND EscrowTransaction.spendingLimitCents >= authorization.amount
  → approve
  → sinon decline
```

Pas de pré-financement. La source de vérité est la ligne `EscrowTransaction` (centimes Int).

---

## 4. Validation d'entrée (OWASP)

- **Zod** à chaque boundary HTTP (Fastify schema + handler).
- **Prisma paramétré** uniquement — zéro interpolation SQL.
- **sha256 obligatoire** sur les reçus scellés.
- **JWT** sur toutes les routes sauf `/health`.
- Erreurs : `{ error: 'SNAKE_CASE_CODE' }` — pas de stack trace exposée en production.
