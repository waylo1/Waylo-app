-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SETTLED', 'FAILED');

-- CreateTable
CREATE TABLE "BuyerCompensationOutbox" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BuyerCompensationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuyerCompensationOutbox_idempotencyKey_key" ON "BuyerCompensationOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BuyerCompensationOutbox_status_idx" ON "BuyerCompensationOutbox"("status");

-- CreateIndex
CREATE INDEX "BuyerCompensationOutbox_buyerId_idx" ON "BuyerCompensationOutbox"("buyerId");

-- CreateIndex
CREATE INDEX "BuyerCompensationOutbox_missionId_idx" ON "BuyerCompensationOutbox"("missionId");

-- AddForeignKey
ALTER TABLE "BuyerCompensationOutbox" ADD CONSTRAINT "BuyerCompensationOutbox_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerCompensationOutbox" ADD CONSTRAINT "BuyerCompensationOutbox_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
