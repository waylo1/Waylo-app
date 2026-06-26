-- WARNING: ALTER TYPE ADD VALUE n'est pas transactionnel en PostgreSQL < 12 et ne peut pas
-- être utilisé dans la même transaction que des INSERT/UPDATE référençant la valeur ajoutée.
-- Ne jamais enchaîner ADD VALUE + INSERT/UPDATE utilisant cette valeur dans un même fichier
-- de migration : séparer en deux migrations distinctes si un backfill est nécessaire.

-- AlterEnum
ALTER TYPE "MissionStatus" ADD VALUE 'ACTIVE';

-- CreateTable
CREATE TABLE "ProcessedAssignmentEvent" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "travelerId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedAssignmentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedAssignmentEvent_missionId_key" ON "ProcessedAssignmentEvent"("missionId");
