-- CreateEnum
CREATE TYPE "DropOffType" AS ENUM ('LOCKER', 'RELAY', 'POSTAL');

-- AlterTable
ALTER TABLE "Mission" ADD COLUMN     "dropOffAccessCode" TEXT,
ADD COLUMN     "dropOffCarrier" TEXT,
ADD COLUMN     "dropOffTrackingId" TEXT,
ADD COLUMN     "dropOffType" "DropOffType",
ADD COLUMN     "droppedAt" TIMESTAMP(3);
