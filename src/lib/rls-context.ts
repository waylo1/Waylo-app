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
export async function withRlsContext<T>(
  ctx: RlsContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // Kill-switch : off/shadow ⇒ bypass (app.bypass_rls='on') ; enforce ⇒ RLS filtre.
  // Fail-safe hérité de FeatureGuard.mode() : toute panne/valeur invalide → 'off' → bypass.
  const mode = await FeatureGuard.mode(ctx.flagKey ?? 'rls.missions')
  const bypass = mode !== 'enforce'

  return prisma.$transaction(async tx => {
    // Plus de `SET LOCAL ROLE` : le rôle de connexion `waylo_user` est déjà
    // NOBYPASSRLS. L'enforcement est piloté par le seul GUC `app.bypass_rls`
    // ci-dessous (posé is_local ⇒ transaction-local).

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

    return fn(tx)
  })
}
