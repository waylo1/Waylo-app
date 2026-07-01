-- Migration 20260630130000 — RLS Policies « Privacy-First » (identité stricte)
--
-- POSTURE : Forteresse. Remplace le verrou d'incident `deny_all` par des
-- politiques granulaires fondées EXCLUSIVEMENT sur l'identité applicative
-- (GUC `app.current_user_id`, posé par src/lib/rls-context.ts).
--
-- REJET PAR DÉFAUT : si `app.current_user_id` est absent/vide (aucun contexte
-- authentifié propagé), aucune ligne utilisateur n'est visible ni mutable.
-- Contrat applicatif : rls-context.ts ne pose `app.current_user_id` QUE pour un
-- principal authentifié ET certifié (KYC). La certification est donc une
-- PRÉCONDITION d'obtention de l'identité, pas un prédicat SQL distinct.
--
-- AUCUN ACCÈS public/anon : aucune politique n'autorise un accès non identifié.
-- Les seules dérogations (`app.is_service`, `app.is_admin`, `app.bypass_rls`)
-- sont des drapeaux de contexte posés UNIQUEMENT par le backend de confiance
-- (jamais atteignables par les rôles PostgREST anon/authenticated), et sont en
-- outre neutralisées par le REVOKE des grants en fin de fichier.
--
-- auth.uid() N'EST PAS UTILISÉ : l'auth Waylo est un JWT maison, pas Supabase
-- Auth — `auth.uid()` retournerait toujours NULL ici.
--
-- Réversibilité : DROP POLICY ... + ALTER TABLE ... DISABLE ROW LEVEL SECURITY.

-- ════════════════════════════════════════════════════════════════════════════
-- Mission
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "Mission" ENABLE ROW LEVEL SECURITY;
-- FORCE : la RLS s'applique AUSSI au propriétaire de la table (pas de bypass implicite).
ALTER TABLE "Mission" FORCE ROW LEVEL SECURITY;

-- Levée du verrou d'incident dans la MÊME transaction de migration que la pose
-- des politiques granulaires : aucune fenêtre où "Mission" est sans politique.
DROP POLICY IF EXISTS "deny_all" ON "Mission";

-- SELECT — participant strict : acheteur OU voyageur de la ligne. Aucun carve-out
-- catalogue ici : /available passe par le contexte service côté backend (cf. plan §C).
-- Identité absente/vide ⇒ aucune ligne (rejet par défaut).
CREATE POLICY mission_select ON "Mission"
  FOR SELECT USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.is_admin',   true) = 'on'
    OR current_setting('app.bypass_rls', true) = 'on'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND (
              "buyerId"    = current_setting('app.current_user_id', true)
           OR "travelerId" = current_setting('app.current_user_id', true)
         )
    )
  );

-- INSERT — un acheteur ne crée QUE ses propres missions (buyerId = appelant).
CREATE POLICY mission_insert ON "Mission"
  FOR INSERT WITH CHECK (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.bypass_rls', true) = 'on'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND "buyerId" = current_setting('app.current_user_id', true)
    )
  );

-- UPDATE — participant strict. USING : lignes visibles ; WITH CHECK : la ligne
-- résultante reste détenue par l'appelant ⇒ pas de réassignation d'ownership par
-- update direct. Workers/webhooks avancent l'état via le contexte service.
CREATE POLICY mission_update ON "Mission"
  FOR UPDATE
  USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.is_admin',   true) = 'on'
    OR current_setting('app.bypass_rls', true) = 'on'
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
    OR current_setting('app.bypass_rls', true) = 'on'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND (
              "buyerId"    = current_setting('app.current_user_id', true)
           OR "travelerId" = current_setting('app.current_user_id', true)
         )
    )
  );

-- DELETE — AUCUNE politique : suppression physique interdite (cycle de vie par
-- statut → CANCELLED/EXPIRED). L'absence de policy permissive = refus total.

-- ════════════════════════════════════════════════════════════════════════════
-- Wallet
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "Wallet" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Wallet" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deny_all" ON "Wallet";

-- SELECT — propriétaire CERTIFIÉ seul (+ dérogations service/admin). Aucun
-- carve-out public. Niveau « bancaire » validé 2026-06-30 : authentifié seul
-- NE SUFFIT PAS, `app.is_certified` (KYC VERIFIED) est EXIGÉ en plus de
-- l'identité — contrairement à Mission (authentification seule).
CREATE POLICY wallet_select ON "Wallet"
  FOR SELECT USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.is_admin',   true) = 'on'
    OR current_setting('app.bypass_rls', true) = 'on'
    OR (
         current_setting('app.current_user_id', true) <> ''
     AND current_setting('app.is_certified',    true) = 'on'
     AND "userId" = current_setting('app.current_user_id', true)
    )
  );

-- INSERT / UPDATE / DELETE — SERVICE UNIQUEMENT.
-- DÉVIATION DÉLIBÉRÉE de « writes par identité » : un utilisateur ne doit JAMAIS
-- muter son propre solde (auto-crédit = création de monnaie). Seul le webhook de
-- capture escrow (contexte service) écrit le Wallet. La RLS est ici le filet
-- anti-fraude financière, pas un simple filtre de visibilité.
-- (FOR ALL couvre aussi SELECT pour le service : union permissive avec wallet_select,
--  sans effet restrictif sur le propriétaire.)
CREATE POLICY wallet_write ON "Wallet"
  FOR ALL
  USING (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.bypass_rls', true) = 'on'
  )
  WITH CHECK (
       current_setting('app.is_service', true) = 'on'
    OR current_setting('app.bypass_rls', true) = 'on'
  );

-- ════════════════════════════════════════════════════════════════════════════
-- Durcissement des grants (Supabase) — zéro accès direct anon/authenticated
-- ════════════════════════════════════════════════════════════════════════════
-- Defense-in-depth : même si une policy avait une faille, les rôles PostgREST
-- n'ont AUCUN privilège de table. Gardé par existence de rôle ⇒ portable sur
-- waylo_test (Postgres nu, sans rôles Supabase).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "Mission" FROM anon;
    REVOKE ALL ON "Wallet"  FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON "Mission" FROM authenticated;
    REVOKE ALL ON "Wallet"  FROM authenticated;
  END IF;
END $$;
