-- Sprint 15 : champs de rejeu/diagnostic du worker de ponction (PenaltyDebitOutbox).
-- Backoff exponentiel (attempts), trace d'échec (lastError), PI de la charge réussie
-- (stripePaymentIntentId @unique) — miroir de TransferOutbox.

-- AlterTable
ALTER TABLE "PenaltyDebitOutbox" ADD COLUMN "stripePaymentIntentId" TEXT;
ALTER TABLE "PenaltyDebitOutbox" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PenaltyDebitOutbox" ADD COLUMN "lastError" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PenaltyDebitOutbox_stripePaymentIntentId_key" ON "PenaltyDebitOutbox"("stripePaymentIntentId");
