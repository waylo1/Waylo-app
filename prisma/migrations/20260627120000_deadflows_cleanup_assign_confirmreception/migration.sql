-- [DEADFLOWS] Suppression flux (c) /assign + statut ACTIVE & flux (b) confirmReception/escrowPayout.
-- Schéma SÉPARÉ de la logique : ce fichier ne porte QUE les changements DB.

-- 1) Backfill AVANT le retrait de la valeur d'enum : missions ACTIVE (cul-de-sac /assign,
--    sans escrow) réorientées en CANCELLED. Cible une valeur CONSERVÉE → aucun échec au cast.
UPDATE "Mission" SET "status" = 'CANCELLED' WHERE "status" = 'ACTIVE';

-- 2) Colonnes liées exclusivement à confirmReception (flux b mort, jamais produit en prod).
ALTER TABLE "Mission" DROP COLUMN "deliveryProofHash";
ALTER TABLE "Mission" DROP COLUMN "receptionConfirmedAt";

-- 3) Ledger d'idempotence d'assignation (flux c mort). Pas de FK → DROP direct.
-- IF EXISTS : certains environnements (prod) ont déjà cette table absente
-- (bootstrap partiel hors-ledger) — DROP TABLE nu y échouerait sans raison.
DROP TABLE IF EXISTS "ProcessedAssignmentEvent";

-- 4) Retrait de la valeur d'enum MissionStatus.ACTIVE. PostgreSQL ne sait pas DROP une
--    valeur d'enum → swap de type complet (drop default → new type → cast → rename → re-default).
--    AWAITING_CONFIRMATION / COMPLETED_BY_BUYER sont CONSERVÉS (orphelins documentés, liés au flux a).
ALTER TABLE "Mission" ALTER COLUMN "status" DROP DEFAULT;
CREATE TYPE "MissionStatus_new" AS ENUM ('CREATED', 'FUNDED', 'MATCHED', 'IN_PROGRESS', 'ESCROW_LOCKED_CUSTOMS', 'PENDING_CUSTOMS_REVIEW', 'AWAITING_VALIDATION', 'VALIDATED', 'DEPOSITED', 'DISPUTED', 'IN_DISPUTE', 'DISPUTED_FRAUD', 'AWAITING_TRAVELER_ACCOUNT', 'RELEASED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'AWAITING_CONFIRMATION', 'COMPLETED_BY_BUYER', 'NOTIFICATION_FAILED');
ALTER TABLE "Mission" ALTER COLUMN "status" TYPE "MissionStatus_new" USING ("status"::text::"MissionStatus_new");
ALTER TYPE "MissionStatus" RENAME TO "MissionStatus_old";
ALTER TYPE "MissionStatus_new" RENAME TO "MissionStatus";
DROP TYPE "MissionStatus_old";
ALTER TABLE "Mission" ALTER COLUMN "status" SET DEFAULT 'CREATED';
