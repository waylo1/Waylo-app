-- Migration 20260630160000 — Rôle applicatif `waylo_app` (NOBYPASSRLS)
--
-- Prérequis du mode RLS « enforce » : `src/lib/rls-context.ts` exécute
-- `SET LOCAL ROLE waylo_app` pour la durée de chaque transaction non-`bypass`.
-- Sans ce rôle, `withRlsContext({ bypass: false }, ...)` échoue (rôle inconnu).
--
-- Idempotent — exécutable sans erreur si déjà appliquée (CREATE ROLE gardé par
-- IF NOT EXISTS, GRANT/ALTER DEFAULT PRIVILEGES sont naturellement idempotents).
-- Portable Supabase ET Postgres nu (waylo_test) — aucune dépendance aux rôles
-- Supabase (anon/authenticated/service_role).

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waylo_app') THEN
    CREATE ROLE waylo_app NOLOGIN NOBYPASSRLS NOSUPERUSER INHERIT;
  END IF;
END $$;

-- USAGE sur le schéma — sans ça : "permission denied for schema public" dès le
-- premier SET LOCAL ROLE waylo_app, même avec des GRANT TABLE en place.
GRANT USAGE ON SCHEMA public TO waylo_app;

-- Grants tables + séquences existantes.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO waylo_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO waylo_app;

-- Default privileges : couvre les tables Prisma futures (nouvelles migrations)
-- sans nouvelle migration `setup_waylo_app`-like à chaque ajout de modèle.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO waylo_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO waylo_app;
