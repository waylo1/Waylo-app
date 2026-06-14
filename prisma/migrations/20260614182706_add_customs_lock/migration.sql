-- AlterEnum
ALTER TYPE "MissionStatus" ADD VALUE 'ESCROW_LOCKED_CUSTOMS';

-- AlterTable
ALTER TABLE "Mission" ADD COLUMN     "customsReceiptSha256" TEXT,
ADD COLUMN     "customsReceiptUrl" TEXT,
ADD COLUMN     "destinationCountry" TEXT;
