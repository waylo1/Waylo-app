-- AlterEnum
ALTER TYPE "MissionStatus" ADD VALUE 'DISPUTED';

-- AlterTable
ALTER TABLE "Mission" ADD COLUMN     "disputeReason" TEXT,
ADD COLUMN     "disputedAt" TIMESTAMP(3);
