-- AlterEnum
ALTER TYPE "MissionStatus" ADD VALUE 'DEPOSITED';

-- AlterTable
ALTER TABLE "Mission" ADD COLUMN     "dropoffAt" TIMESTAMP(3),
ADD COLUMN     "dropoffReceiptUrl" TEXT,
ADD COLUMN     "dropoffTrackingNumber" TEXT;
