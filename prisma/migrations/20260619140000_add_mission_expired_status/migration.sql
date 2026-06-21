-- AlterEnum
-- Ghost mission lifecycle (audit robustesse) : statut terminal des missions CREATED
-- jamais financées et expirées. ADD VALUE additif, rétro-compatible (aucun backfill).
ALTER TYPE "MissionStatus" ADD VALUE 'EXPIRED';
