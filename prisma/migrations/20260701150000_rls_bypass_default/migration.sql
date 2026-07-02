-- Migration 20260701150000 — « Bypass par défaut » porté par les policies
--
-- CONTEXTE : le runtime bascule du rôle `postgres` (BYPASSRLS) vers `waylo_user`
-- (NOBYPASSRLS, migration 20260701140000). Les chemins « client Prisma nu »
-- (workers, webhooks Stripe, routes financières) qui ne passent PAS par
-- `withRlsContext` ne posent aucun GUC ⇒ avec l'ancienne clause
-- `current_setting('app.bypass_rls', true) = 'on'`, ils seraient refusés
-- (GUC absent ⇒ NULL ⇒ deny). Ça casserait la prod.
--
-- CORRECTIF : la clause d'échappement devient
--   current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
-- ⇒ GUC ABSENT (NULL) ou 'on'  → TRUE  → bypass (continuité de service) ;
--   GUC = 'off' (posé is_local par withRlsContext en mode enforce) → FALSE → RLS filtre.
--
-- POURQUOI ICI ET PAS AU NIVEAU DU RÔLE : persister `app.bypass_rls='on'` via
-- `ALTER ROLE waylo_user SET` exige un superuser sur Supabase (`postgres` ⇒
-- 42501). Les policies sont possédées par `postgres` (owner des tables) ⇒
-- modifiables sans superuser. Même intention, mécanisme déployable.
--
-- POSTURE : « fail-open » quand le GUC est absent (chemins nus), « fail-closed »
-- dès que `withRlsContext` pose `bypass_rls='off'` (enforce réel). Miroir exact
-- du comportement actuel (les chemins nus bypassent déjà via postgres BYPASSRLS).
--
-- Réversible : ré-appliquer 20260630130000 (clause `= 'on'`). Idempotent (DROP IF EXISTS).

-- ════════════════════════════════════════════════════════════════════════════
-- Mission — mission_select / mission_insert / mission_update
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS mission_select ON "Mission";
CREATE POLICY mission_select ON "Mission"
  FOR SELECT USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.is_admin',   true) = 'on'
    OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND (
              "buyerId"    = current_setting('app.current_user_id', true)
           OR "travelerId" = current_setting('app.current_user_id', true)
         )
    )
  );

DROP POLICY IF EXISTS mission_insert ON "Mission";
CREATE POLICY mission_insert ON "Mission"
  FOR INSERT WITH CHECK (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND "buyerId" = current_setting('app.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS mission_update ON "Mission";
CREATE POLICY mission_update ON "Mission"
  FOR UPDATE
  USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.is_admin',   true) = 'on'
    OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND (
              "buyerId"    = current_setting('app.current_user_id', true)
           OR "travelerId" = current_setting('app.current_user_id', true)
         )
    )
  )
  WITH CHECK (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.is_admin',   true) = 'on'
    OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND (
              "buyerId"    = current_setting('app.current_user_id', true)
           OR "travelerId" = current_setting('app.current_user_id', true)
         )
    )
  );

-- ════════════════════════════════════════════════════════════════════════════
-- Wallet — wallet_select (propriétaire certifié) / wallet_write (service-only)
-- ════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS wallet_select ON "Wallet";
CREATE POLICY wallet_select ON "Wallet"
  FOR SELECT USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.is_admin',   true) = 'on'
    OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND current_setting('app.is_certified',    true) = 'on'
     AND "userId" = current_setting('app.current_user_id', true)
    )
  );

DROP POLICY IF EXISTS wallet_write ON "Wallet";
CREATE POLICY wallet_write ON "Wallet"
  FOR ALL
  USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
  )
  WITH CHECK (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.bypass_rls', true) IS DISTINCT FROM 'off'
  );
