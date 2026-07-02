-- Migration 20260701140000 — Rôle runtime applicatif `waylo_user` (NOBYPASSRLS)
--
-- OBJECTIF : séparer Maintenance/Migrations (rôle `postgres`, owner des tables)
-- du Runtime applicatif (`waylo_user`, moindre privilège). L'enforcement RLS
-- vient du fait que `waylo_user` ne peut PAS bypasser la RLS (NOBYPASSRLS,
-- non-owner) — contrairement à `postgres` (BYPASSRLS) utilisé jusqu'ici.
--
-- CONTINUITÉ DE SERVICE : les nombreux chemins « client Prisma nu » (workers,
-- webhooks Stripe, routes financières funding/logistics/admin/validation) qui
-- comptaient sur le BYPASSRLS de `postgres` verraient sinon `deny_all` par défaut.
-- Parade : « bypass par défaut » porté PAR LES POLICIES (migration
-- `20260701150000_rls_bypass_default` : clause `bypass_rls IS DISTINCT FROM 'off'`
-- ⇒ GUC absent = bypass). `withRlsContext` neutralise ce défaut PAR TRANSACTION
-- en mode enforce via `set_config('app.bypass_rls', 'off', true)` (is_local).
--
-- NOTE : on ne pose PAS `ALTER ROLE waylo_user SET app.bypass_rls='on'` — sur
-- Supabase, persister un GUC placeholder `app.*` au niveau du rôle exige un
-- superuser (`postgres` ⇒ `42501 permission denied to set parameter`). Le défaut
-- vit donc dans les policies (déployables par `postgres`, owner des tables).
--
-- CONTRAINTE : AUCUNE modification du rôle `postgres`. Idempotent (ré-exécutable).
--
-- MOT DE PASSE : volontairement ABSENT de ce fichier (secret hors-git). Il est
-- posé par environnement, hors migration :
--   ALTER ROLE waylo_user PASSWORD '<secret>';   -- prod : Supabase SQL / psql
-- Sur `waylo_test`, la suite se connecte en `flipsync` : `waylo_user` n'a pas
-- besoin de mot de passe pour que les tests tournent.

-- 1) Rôle : LOGIN, NOBYPASSRLS, non-superuser. Créable par `postgres` (CREATEROLE)
--    comme par le superuser local `flipsync`. Convergence si préexistant.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waylo_user') THEN
    CREATE ROLE waylo_user WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE waylo_user WITH LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- 2) Accès schéma + tables + séquences EXISTANTES (mêmes grants que setup_waylo_app).
GRANT USAGE ON SCHEMA public TO waylo_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO waylo_user;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO waylo_user;

-- 3) Tables/séquences FUTURES créées par le rôle courant (postgres en prod,
--    flipsync en local) — pas de `FOR ROLE postgres` codé en dur (le rôle
--    `postgres` n'existe pas sur `waylo_test`), forme portable identique à
--    setup_waylo_app.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO waylo_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO waylo_user;

-- Le « bypass par défaut » n'est PAS posé ici (ALTER ROLE SET ⇒ superuser requis) :
-- il est porté par les policies dans la migration 20260701150000_rls_bypass_default.
