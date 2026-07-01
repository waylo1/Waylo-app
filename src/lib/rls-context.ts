import { Prisma } from '../generated/prisma'
import { prisma } from '../db'
import { FeatureGuard } from './feature-guard'

/**
 * Contexte RLS — propagation de l'identité applicative vers PostgreSQL.
 *
 * RÔLE : exécuter un bloc de travail Prisma dans une transaction où les GUC
 * `app.*` sont posés, de sorte que les politiques RLS (migration
 * `20260630130000_enable_rls_policies`) filtrent les lignes selon l'appelant.
 *
 * INVARIANT DE SÉCURITÉ — REJET PAR DÉFAUT, DEUX NIVEAUX (validé 2026-06-30) :
 *   - `app.current_user_id` : posé dès qu'un `userId` authentifié est fourni —
 *     SUFFIT pour les politiques Mission (lecture/écriture dès authentification,
 *     pas de gate KYC : fluidité UX sur la création/consultation de mission).
 *   - `app.is_certified` : posé séparément, reflète UNIQUEMENT `ctx.isCertified`
 *     (KYC `VERIFIED`). Les politiques Wallet l'EXIGENT en plus de l'identité
 *     (niveau de sécurité bancaire — cf. migration `enable_rls_policies`,
 *     section Wallet). Un appelant authentifié mais non certifié garde l'accès
 *     à SES missions ; son Wallet reste invisible côté RLS (l'appelant DOIT
 *     vérifier `isCertified` côté route avant lecture, pour ne pas confondre
 *     « Wallet masqué par RLS » et « Wallet vide » — cf. wallet.route.ts).
 *
 * MÉCANIQUE (Phase D, 2026-07-01) :
 *   - `set_config(key, val, true)` : GUC TRANSACTION-LOCAL (3ᵉ arg = is_local).
 *     Réinitialisé automatiquement au COMMIT/ROLLBACK ⇒ aucune pollution du pool.
 *   - PLUS de `SET LOCAL ROLE` : le runtime se connecte via le rôle `waylo_user`
 *     (NOBYPASSRLS, non-owner — migration `20260701140000_create_waylo_user`).
 *     L'enforcement RLS vient donc DIRECTEMENT du rôle de connexion : en mode
 *     enforce on pose `app.bypass_rls = 'off'` (is_local) ⇒ les politiques
 *     filtrent par identité. En mode bypass on pose `app.bypass_rls = 'on'`
 *     (clause d'échappement des policies) ⇒ inerte. La continuité de service des
 *     chemins « prisma nu » (workers/webhooks/financier) hors `withRlsContext`
 *     est garantie par le DÉFAUT DES POLICIES : clause
 *     `app.bypass_rls IS DISTINCT FROM 'off'` (migration `20260701150000`) ⇒ GUC
 *     absent = bypass. Le rôle `waylo_app` + `SET LOCAL ROLE` sont abandonnés
 *     (impossibles sur Supabase : le GRANT WITH SET coupe la session, cf.
 *     migration no-op `20260701130000`). Le défaut n'a PAS pu être posé au niveau
 *     du rôle (`ALTER ROLE SET` d'un GUC placeholder ⇒ superuser requis).
 *
 * ÉTAT : câblé sur les routes de LECTURE Mission/Wallet (crud.route.ts,
 * wallet.route.ts). Le bypass n'est pas codé en dur : il est dérivé du
 * kill-switch `FeatureGuard.mode(flagKey)` (table `FeatureFlag`, clés
 * `rls.missions` / `rls.wallets`) — off/shadow ⇒ `app.bypass_rls='on'`,
 * enforce ⇒ `app.bypass_rls='off'`. Propagation < 5 s (TTL cache `FeatureGuard`),
 * `kill()` évince le cache immédiatement (cf. feature-guard.ts).
 *
 * SHADOW MODE (`ctx.readOnly=true` requis, appels actuels tous des lectures) :
 * `fn` est rejoué sous `app.bypass_rls='off'` dans une SAVEPOINT annulée, pour
 * comparer au résultat réel (bypass actif) sans rien persister. Un écart
 * vide/non-vide est enregistré via `log_rls_shadow_mismatch` (migration
 * `20260701160000_rls_shadow_observability`). `readOnly` défaut `false` : ne
 * JAMAIS l'activer sur un bloc qui écrit (le rejeu doublerait l'effet de bord).
 * NON câblé : routes multi-étapes couplées Stripe (funding, logistics/capture)
 * — `withRlsContext` ouvre une `$transaction` Prisma ; y inclure un appel Stripe
 * violerait l'invariant verrouillé (docs/DECISIONS.md §1 : « Tout appel Stripe
 * est interdit dans une $transaction Prisma »). Ces routes restent sur le
 * client `prisma` nu (RLS inerte, rôle BYPASSRLS) jusqu'à une revue dédiée
 * (CAS atomique + Stripe hors-transaction à préserver explicitement).
 */

export interface RlsContext {
  /** Identité du principal authentifié. Propagée dès présence (pas de gate KYC ici). */
  userId?: string | null
  /** KYC `VERIFIED`. Requis en plus de `userId` pour les politiques Wallet uniquement. */
  isCertified?: boolean
  /** Dérogation admin (back-office). Posée uniquement par le backend de confiance. */
  isAdmin?: boolean
  /** Dérogation service (workers, webhooks, lecture catalogue /available). */
  isService?: boolean
  /**
   * Clé `FeatureFlag` qui pilote l'enforcement de CETTE transaction
   * (`rls.missions` par défaut, `rls.wallets` pour les routes Wallet).
   * mode `off`/`shadow` ⇒ `app.bypass_rls='on'` (politiques inertes) ;
   * mode `enforce` ⇒ `app.bypass_rls='off'` (le rôle `waylo_user` NOBYPASSRLS
   * fait alors filtrer les policies par identité).
   */
  flagKey?: string
  /**
   * `fn` n'a AUCUN effet de bord (lecture pure) — condition requise pour activer
   * la double-exécution de comparaison en mode `shadow` (migration
   * `20260701160000_rls_shadow_observability`). Défaut `false` : par sécurité,
   * pas de rejeu implicite d'un bloc qui pourrait écrire (financier notamment).
   */
  readOnly?: boolean
}

/** Correspondance flagKey → table, pour l'enregistrement des écarts shadow. */
const FLAG_TABLE: Record<string, string> = {
  'rls.missions': 'Mission',
  'rls.wallets': 'Wallet',
}

function isEmptyResult(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.length === 0)
}

/**
 * Exécute `fn` dans une transaction Prisma dont le contexte RLS est posé.
 * Le bypass est dérivé de `FeatureGuard.mode(ctx.flagKey ?? 'rls.missions')` —
 * jamais fourni par l'appelant.
 *
 * @example
 *   const mission = await withRlsContext(
 *     { userId: req.user.sub, isCertified: true },
 *     tx => tx.mission.findUnique({ where: { id } }),
 *   )
 */
async function setRlsGuc(
  tx: Prisma.TransactionClient,
  ctx: RlsContext,
  bypass: boolean,
): Promise<void> {
  // Identité effective : non vide dès qu'un userId authentifié est fourni.
  // Sinon chaîne vide ⇒ les politiques `current_user_id <> '' AND owner = ...`
  // échouent ⇒ rejet par défaut (principal anonyme).
  const effectiveUserId = ctx.userId ?? ''

  // GUC transaction-locaux. `${...}` = paramètres liés (texte, anti-injection) ;
  // le 3ᵉ argument `true` (is_local) est un littéral. $queryRaw car SELECT.
  await tx.$queryRaw`SELECT
    set_config('app.current_user_id', ${effectiveUserId}, true),
    set_config('app.is_certified',    ${ctx.isCertified ? 'on' : 'off'}, true),
    set_config('app.is_admin',        ${ctx.isAdmin ? 'on' : 'off'}, true),
    set_config('app.is_service',      ${ctx.isService ? 'on' : 'off'}, true),
    set_config('app.bypass_rls',      ${bypass ? 'on' : 'off'}, true)`
}

/**
 * Mode `shadow` + `ctx.readOnly` : rejoue `fn` une seconde fois sous
 * `app.bypass_rls='off'` (dans une savepoint annulée ensuite — aucune écriture
 * persistée) pour comparer au résultat réel servi à l'appelant (bypass actif).
 * Écart de « vide vs non-vide » ⇒ enregistré via `log_rls_shadow_mismatch`
 * (migration `20260701160000_rls_shadow_observability`). Best-effort : toute
 * erreur du probe est avalée, elle ne doit jamais faire échouer la requête réelle.
 */
async function logShadowMismatch<T>(
  tx: Prisma.TransactionClient,
  ctx: RlsContext,
  flagKey: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  actual: T,
): Promise<void> {
  try {
    await tx.$queryRaw`SAVEPOINT rls_shadow_probe`
    await setRlsGuc(tx, ctx, false)

    // Un `fn` d'accès à une ressource unique (ex. GET /:id) throw (404) plutôt que
    // de renvoyer vide quand l'accès est refusé — c'est PRÉCISÉMENT l'écart à
    // détecter, donc on le convertit en résultat vide plutôt que de le laisser
    // remonter (le catch englobant ci-dessous est réservé aux pannes du probe lui-même).
    const enforced: T | null = await fn(tx).catch(() => null)

    await tx.$queryRaw`ROLLBACK TO SAVEPOINT rls_shadow_probe`
    await setRlsGuc(tx, ctx, true)

    const wouldEnforceAllow = !isEmptyResult(enforced)
    const actualBypassAllow = !isEmptyResult(actual)
    if (wouldEnforceAllow !== actualBypassAllow) {
      await tx.$queryRaw`SELECT log_rls_shadow_mismatch(
        ${flagKey}, ${FLAG_TABLE[flagKey] ?? 'unknown'}, 'READ',
        ${ctx.userId ?? null}, ${wouldEnforceAllow}, ${actualBypassAllow})`
    }
  } catch {
    // Le probe shadow est un aparté d'observabilité — jamais bloquant.
  }
}

export async function withRlsContext<T>(
  ctx: RlsContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // Kill-switch : off/shadow ⇒ bypass (app.bypass_rls='on') ; enforce ⇒ RLS filtre.
  // Fail-safe hérité de FeatureGuard.mode() : toute panne/valeur invalide → 'off' → bypass.
  const flagKey = ctx.flagKey ?? 'rls.missions'
  const mode = await FeatureGuard.mode(flagKey)
  const bypass = mode !== 'enforce'

  return prisma.$transaction(async tx => {
    // Plus de `SET LOCAL ROLE` : le rôle de connexion `waylo_user` est déjà
    // NOBYPASSRLS. L'enforcement est piloté par le seul GUC `app.bypass_rls`
    // ci-dessous (posé is_local ⇒ transaction-local).
    await setRlsGuc(tx, ctx, bypass)
    const result = await fn(tx)

    if (mode === 'shadow' && ctx.readOnly) {
      await logShadowMismatch(tx, ctx, flagKey, fn, result)
    }

    return result
  })
}
