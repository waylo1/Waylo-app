-- Sprint 16 (modèle « Drive ») : pré-autorisation acheteur de la substitution.
-- Colonne booléenne NOT NULL DEFAULT false — rétro-compatible (aucun backfill :
-- toutes les missions existantes conservent le comportement historique « reçu > budget refusé »).

-- AlterTable
ALTER TABLE "Mission" ADD COLUMN "substitutionAuthorized" BOOLEAN NOT NULL DEFAULT false;
