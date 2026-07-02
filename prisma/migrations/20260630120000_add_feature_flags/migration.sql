-- Migration 20260630120000 — Feature Flags RLS
-- Ajout pur, aucune donnée existante touchée. Réversible : DROP TABLE "FeatureFlag".

CREATE TABLE "FeatureFlag" (
  "key"         TEXT        NOT NULL,
  "mode"        TEXT        NOT NULL DEFAULT 'off',
  "description" TEXT,
  "updatedBy"   TEXT,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- Seed initial : deux flags, état 'off' (RLS inerte au démarrage).
INSERT INTO "FeatureFlag" ("key", "mode", "description", "updatedAt")
VALUES
  ('rls.missions', 'off', 'RLS isolation table Mission (off→shadow→enforce)', CURRENT_TIMESTAMP),
  ('rls.wallets',  'off', 'RLS isolation table Wallet  (off→shadow→enforce)', CURRENT_TIMESTAMP);
