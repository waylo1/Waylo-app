-- Migration 20260701160000 — Observabilité Shadow Mode (RLS)
--
-- Additive pur : ne touche ni policies, ni rôles, ni FeatureFlag. Fournit la
-- brique manquante pour que le mode `shadow` produise un signal réel : une
-- table de log + une fonction par table qui évalue le prédicat d'identité
-- SANS la clause de bypass (« ce que enforce aurait décidé »), comparée au
-- résultat effectif en bypass. Le câblage applicatif (appel depuis
-- withRlsContext) est une tâche séparée — cette migration seule est un no-op
-- tant qu'elle n'est pas appelée.

CREATE TABLE IF NOT EXISTS "RlsShadowMismatch" (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "flagKey"     TEXT NOT NULL,
  "tableName"   TEXT NOT NULL,
  operation     TEXT NOT NULL,
  "userId"      TEXT,
  "wouldEnforceAllow" BOOLEAN NOT NULL,
  "actualBypassAllow" BOOLEAN NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_rls_shadow_mismatch_flagkey_createdat"
  ON "RlsShadowMismatch" ("flagKey", "createdAt");

-- Prédicat d'identité pur (sans bypass) pour Mission — miroir exact de mission_select/update.
CREATE OR REPLACE FUNCTION fn_rls_would_allow_mission(
  p_user_id TEXT, p_is_admin TEXT, p_is_service TEXT,
  p_buyer_id TEXT, p_traveler_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_is_service = 'on'
      OR p_is_admin   = 'on'
      OR (p_user_id <> '' AND (p_buyer_id = p_user_id OR p_traveler_id = p_user_id));
$$;

-- Prédicat d'identité pur pour Wallet (wallet_select) — wallet_write reste service-only par design.
CREATE OR REPLACE FUNCTION fn_rls_would_allow_wallet(
  p_user_id TEXT, p_is_admin TEXT, p_is_service TEXT,
  p_is_certified TEXT, p_wallet_user_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_is_service = 'on'
      OR p_is_admin   = 'on'
      OR (p_user_id <> '' AND p_is_certified = 'on' AND p_wallet_user_id = p_user_id);
$$;

-- Fonction d'enregistrement, appelable depuis l'app (tx.$queryRaw). Ne log QUE les écarts.
CREATE OR REPLACE FUNCTION log_rls_shadow_mismatch(
  p_flag_key TEXT, p_table_name TEXT, p_operation TEXT,
  p_user_id TEXT, p_would_enforce_allow BOOLEAN, p_actual_bypass_allow BOOLEAN
) RETURNS VOID
LANGUAGE sql AS $$
  INSERT INTO "RlsShadowMismatch"
    ("flagKey","tableName",operation,"userId","wouldEnforceAllow","actualBypassAllow")
  SELECT p_flag_key, p_table_name, p_operation, p_user_id, p_would_enforce_allow, p_actual_bypass_allow
  WHERE p_would_enforce_allow IS DISTINCT FROM p_actual_bypass_allow;
$$;
