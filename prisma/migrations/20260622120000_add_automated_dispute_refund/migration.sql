-- AlterEnum : litige AUTOMATISÉ (distinct de DISPUTED à arbitrage humain).
-- (ADD VALUE non utilisé dans CETTE migration → compatible transaction PG 12+ :
--  aucune colonne/DEFAULT ne référence la nouvelle valeur ici.)
ALTER TYPE "MissionStatus" ADD VALUE 'IN_DISPUTE';

-- AlterEnum : fait métier d'outbox consommé par DisputeResolutionWorker.
ALTER TYPE "OutboxEventType" ADD VALUE 'READY_FOR_REFUND';

-- AlterTable : horodatage d'ouverture + échéance (now + 72 h) du litige automatisé.
ALTER TABLE "Mission" ADD COLUMN     "disputeOpenedAt" TIMESTAMP(3),
ADD COLUMN     "disputeDeadline" TIMESTAMP(3);
