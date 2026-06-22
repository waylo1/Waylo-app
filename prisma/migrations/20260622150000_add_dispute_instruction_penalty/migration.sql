-- Pénalité d'INSTRUCTION (contestation manifestement abusive) : frais fixes 150,00 €
-- (15000 centimes Int). Distinct de la ponction de fraude 200% (PenaltyDebitOutbox).
-- Tous les enums sont CRÉÉS ici (CREATE TYPE) → l'usage de leurs valeurs en DEFAULT
-- dans la même migration est sûr (la restriction PG ne vise que ALTER TYPE ADD VALUE).

-- CreateEnum
CREATE TYPE "PenaltyReason" AS ENUM ('ABUSIVE_DISPUTE');

-- CreateEnum
CREATE TYPE "PenaltyStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- AlterTable : flag d'abus (défaut false = bonne foi, jamais de pénalité).
ALTER TABLE "Mission" ADD COLUMN     "isContestAbusive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable : état de compte (SUSPENDED = blacklist auto sur échec de prélèvement).
ALTER TABLE "User" ADD COLUMN     "accountStatus" "AccountStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "Penalty" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL DEFAULT 15000,
    "reason" "PenaltyReason" NOT NULL,
    "status" "PenaltyStatus" NOT NULL DEFAULT 'PENDING',
    "stripePaymentIntentId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Penalty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Penalty_missionId_key" ON "Penalty"("missionId");

-- CreateIndex
CREATE UNIQUE INDEX "Penalty_stripePaymentIntentId_key" ON "Penalty"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "Penalty_userId_idx" ON "Penalty"("userId");

-- CreateIndex
CREATE INDEX "Penalty_status_idx" ON "Penalty"("status");

-- AddForeignKey
ALTER TABLE "Penalty" ADD CONSTRAINT "Penalty_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Penalty" ADD CONSTRAINT "Penalty_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
