-- AlterEnum
-- Statut non-bloquant : voyageur non notifié après épuisement Watchdog (mission-created).
-- ADD VALUE additif, rétro-compatible (aucun backfill, aucune référence dans cette migration).
ALTER TYPE "MissionStatus" ADD VALUE 'NOTIFICATION_FAILED';

-- CreateTable
-- Ledger d'idempotence pour les notifications post-création. PAS de FK Mission (indépendance délibérée).
CREATE TABLE "ProcessedMissionEvent" (
    "id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMissionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedMissionEvent_alias_missionId_key" ON "ProcessedMissionEvent"("alias", "missionId");
