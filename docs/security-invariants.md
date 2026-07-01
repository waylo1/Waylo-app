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

## 1. RLS Enforcement via le rôle runtime `waylo_user`

### Principe

PostgreSQL Row Level Security (RLS) avec `FORCE ROW LEVEL SECURITY` n'est **pas suffisant** si
la connexion de pool tourne avec un rôle `BYPASSRLS=true` (`postgres`, sur Supabase). La parade
retenue : un rôle de **connexion** dédié, `waylo_user`, créé `NOBYPASSRLS`, utilisé comme rôle
runtime (`url` Prisma) — par opposition à `postgres`, réservé aux migrations (`directUrl`).

> **Abandonné** : basculer le rôle *par transaction* via `SET LOCAL ROLE waylo_app`. Nécessitait
> `GRANT waylo_app TO postgres WITH SET TRUE`, qui **coupe la session** sur Supabase (blocage de
> l'auto-modification du rôle réservé `postgres`) — reproductible via Prisma et via MCP direct.
> Pas de contournement sans accès superuser. Voir [`README_SECURITY.md`](../README_SECURITY.md).

Puisque le rôle ne peut plus être changé au niveau transaction, le bypass « par défaut » (modes
`off`/`shadow`, et tous les chemins hors `withRlsContext`) est porté par une clause dans les
policies elles-mêmes plutôt que par un attribut de rôle :

```sql
current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
```

GUC absent (session hors `withRlsContext`) ou `'on'` (mode `off`/`shadow`) ⇒ bypass ; `'off'`
(posé explicitement par `withRlsContext` en mode `enforce`) ⇒ policy pleinement évaluée.

### Implémentation

Fichier : [`src/lib/rls-context.ts`](../src/lib/rls-context.ts)

```typescript
export async function withRlsContext<T>(
  ctx: RlsContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const mode = await FeatureGuard.mode(ctx.flagKey ?? 'rls.missions')
  const bypass = mode !== 'enforce'

  return prisma.$transaction(async tx => {
    // Le rôle de connexion `waylo_user` est déjà NOBYPASSRLS — pas de SET LOCAL ROLE.
    // L'enforcement est piloté par le seul GUC `app.bypass_rls` (transaction-local).
    await tx.$queryRaw`SELECT
      set_config('app.current_user_id', ${ctx.userId ?? ''}, true),
      set_config('app.is_certified',    ${ctx.isCertified ? 'on' : 'off'}, true),
      set_config('app.is_admin',        ${ctx.isAdmin ? 'on' : 'off'}, true),
      set_config('app.is_service',      ${ctx.isService ? 'on' : 'off'}, true),
      set_config('app.bypass_rls',      ${bypass ? 'on' : 'off'}, true)`
    return fn(tx)
  })
}
```

| Mode `FeatureGuard` | `app.bypass_rls` | Rôle de connexion | Politiques RLS | Usage |
|---|---|---|---|---|
| `off` / `shadow` | `on` | `waylo_user` (NOBYPASSRLS) | inactives (clause bypass) | défaut, sans risque |
| `enforce` | `off` | `waylo_user` (NOBYPASSRLS) | **actives** | isolation réelle |
| *(hors `withRlsContext`)* | absent | `postgres` (BYPASSRLS) ou `waylo_user` | inactives | routes financières non câblées (§ tableau WIP) |

### Activation progressive (FeatureGuard)

```
off     → shadow  → enforce
         (logs)    (app.bypass_rls='off' ⇒ policies actives)
```

- `shadow` : les GUC sont posés, `bypass=true` → policies inactives, mais métriques `rls_shadow_mismatch_total` accumulées.
- `enforce` : `bypass=false` → clause de policy évaluée à chaque requête sur `waylo_user`.
- Kill switch : `FeatureGuard.kill('rls.missions', adminId)` — propagation < 5 s.

### Prérequis de déploiement

Deux migrations, déployées en prod :

1. [`20260701140000_create_waylo_user`](../prisma/migrations/20260701140000_create_waylo_user/migration.sql) —
   crée le rôle `waylo_user` (`LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE`), grants
   CRUD sur toutes les tables/séquences + default privileges pour les futures tables Prisma.
   *(Le « bypass par défaut » n'y est **pas** posé via `ALTER ROLE ... SET` : cela nécessite un
   accès superuser, absent sur Supabase — `42501: permission denied to set parameter`.)*
2. [`20260701150000_rls_bypass_default`](../prisma/migrations/20260701150000_rls_bypass_default/migration.sql) —
   réécrit les policies `mission_*`/`wallet_*` avec la clause `IS DISTINCT FROM 'off'`.

### Tests de régression

Fichier : [`src/security/rls-isolation.test.ts`](../src/security/rls-isolation.test.ts) (app-layer, 9/9)

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
