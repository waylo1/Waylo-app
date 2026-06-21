-- AlterEnum : nouveaux statuts du cycle de vie de confirmation de réception.
-- (ADD VALUE non utilisé dans CETTE migration → compatible transaction PG 12+.)
ALTER TYPE "MissionStatus" ADD VALUE 'AWAITING_CONFIRMATION';
ALTER TYPE "MissionStatus" ADD VALUE 'COMPLETED_BY_BUYER';

-- CreateEnum
CREATE TYPE "OutboxEventType" AS ENUM ('READY_FOR_PAYOUT');

-- AlterTable : preuve de livraison scellée + horodatage de confirmation acheteur.
ALTER TABLE "Mission" ADD COLUMN     "deliveryProofHash" TEXT,
ADD COLUMN     "receptionConfirmedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "type" "OutboxEventType" NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_status_idx" ON "OutboxEvent"("status");

-- CreateIndex
CREATE INDEX "OutboxEvent_missionId_idx" ON "OutboxEvent"("missionId");

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
