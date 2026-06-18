-- AlterEnum
ALTER TYPE "MissionStatus" ADD VALUE 'DISPUTED_FRAUD';

-- AlterEnum
ALTER TYPE "LedgerType" ADD VALUE 'FRAUD_PENALTY_COLLECTED';
ALTER TYPE "LedgerType" ADD VALUE 'BUYER_REFUND_COMPENSATION';

-- CreateTable
CREATE TABLE "PenaltyDebitOutbox" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PenaltyDebitOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PenaltyDebitOutbox_missionId_key" ON "PenaltyDebitOutbox"("missionId");

-- CreateIndex
CREATE INDEX "PenaltyDebitOutbox_userId_idx" ON "PenaltyDebitOutbox"("userId");

-- CreateIndex
CREATE INDEX "PenaltyDebitOutbox_status_idx" ON "PenaltyDebitOutbox"("status");

-- AddForeignKey
ALTER TABLE "PenaltyDebitOutbox" ADD CONSTRAINT "PenaltyDebitOutbox_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PenaltyDebitOutbox" ADD CONSTRAINT "PenaltyDebitOutbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
