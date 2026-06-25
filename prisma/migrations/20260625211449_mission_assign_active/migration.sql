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
