-- CreateEnum
CREATE TYPE "Role" AS ENUM ('BUYER', 'TRAVELER');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MissionStatus" AS ENUM ('CREATED', 'MATCHED', 'IN_PROGRESS', 'AWAITING_VALIDATION', 'AWAITING_TRAVELER_ACCOUNT', 'RELEASED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('HELD', 'RELEASED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('CAPTURE', 'PAYOUT', 'COMMISSION', 'REFUND');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SETTLED', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "SubstitutionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ITEM_SKIPPED');

-- CreateEnum
CREATE TYPE "AuthDecision" AS ENUM ('APPROVED', 'DECLINED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "email" TEXT NOT NULL,
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "stripeCustomerId" TEXT,
    "stripeAccountId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "travelerId" TEXT,
    "status" "MissionStatus" NOT NULL DEFAULT 'CREATED',
    "targetProduct" TEXT NOT NULL,
    "budgetCents" INTEGER NOT NULL,
    "commissionCents" INTEGER NOT NULL,
    "destination" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowTransaction" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT NOT NULL,
    "capturedAmountCents" INTEGER NOT NULL DEFAULT 0,
    "status" "EscrowStatus" NOT NULL DEFAULT 'HELD',
    "stripeIssuingCardId" TEXT,
    "spendingLimitCents" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EscrowTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransferOutbox" (
    "id" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "stripeTransferId" TEXT,
    "destinationAccountId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TransferOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "escrowId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubstitutionRequest" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "lineItemRef" TEXT NOT NULL,
    "proposedProduct" TEXT NOT NULL,
    "proposedPriceCents" INTEGER NOT NULL,
    "status" "SubstitutionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SubstitutionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "totalTtcCents" INTEGER NOT NULL,
    "sha256Client" TEXT NOT NULL,
    "sha256Server" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedStripeEvent" (
    "id" TEXT NOT NULL,
    "stripeEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedStripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuingAuthorizationLog" (
    "id" TEXT NOT NULL,
    "missionId" TEXT,
    "stripeAuthorizationId" TEXT NOT NULL,
    "requestedAmountCents" INTEGER NOT NULL,
    "decision" "AuthDecision" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuingAuthorizationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeAccountId_key" ON "User"("stripeAccountId");

-- CreateIndex
CREATE INDEX "Mission_buyerId_idx" ON "Mission"("buyerId");

-- CreateIndex
CREATE INDEX "Mission_travelerId_idx" ON "Mission"("travelerId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowTransaction_missionId_key" ON "EscrowTransaction"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowTransaction_stripePaymentIntentId_key" ON "EscrowTransaction"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowTransaction_stripeIssuingCardId_key" ON "EscrowTransaction"("stripeIssuingCardId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowTransaction_idempotencyKey_key" ON "EscrowTransaction"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TransferOutbox_stripeTransferId_key" ON "TransferOutbox"("stripeTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferOutbox_idempotencyKey_key" ON "TransferOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TransferOutbox_status_idx" ON "TransferOutbox"("status");

-- CreateIndex
CREATE INDEX "TransferOutbox_escrowId_idx" ON "TransferOutbox"("escrowId");

-- CreateIndex
CREATE INDEX "LedgerEntry_escrowId_idx" ON "LedgerEntry"("escrowId");

-- CreateIndex
CREATE INDEX "SubstitutionRequest_missionId_idx" ON "SubstitutionRequest"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_missionId_key" ON "Receipt"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedStripeEvent_stripeEventId_key" ON "ProcessedStripeEvent"("stripeEventId");

-- CreateIndex
CREATE UNIQUE INDEX "IssuingAuthorizationLog_stripeAuthorizationId_key" ON "IssuingAuthorizationLog"("stripeAuthorizationId");

-- CreateIndex
CREATE INDEX "IssuingAuthorizationLog_missionId_idx" ON "IssuingAuthorizationLog"("missionId");

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_travelerId_fkey" FOREIGN KEY ("travelerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowTransaction" ADD CONSTRAINT "EscrowTransaction_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransferOutbox" ADD CONSTRAINT "TransferOutbox_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "EscrowTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "EscrowTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubstitutionRequest" ADD CONSTRAINT "SubstitutionRequest_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuingAuthorizationLog" ADD CONSTRAINT "IssuingAuthorizationLog_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

