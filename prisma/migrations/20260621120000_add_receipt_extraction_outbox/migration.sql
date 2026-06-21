-- CreateEnum
CREATE TYPE "ReceiptJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "ReceiptExtractionOutbox" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "imageData" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "status" "ReceiptJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "resultJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReceiptExtractionOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceiptExtractionOutbox_status_idx" ON "ReceiptExtractionOutbox"("status");

-- CreateIndex
CREATE INDEX "ReceiptExtractionOutbox_missionId_idx" ON "ReceiptExtractionOutbox"("missionId");

-- CreateIndex
CREATE INDEX "ReceiptExtractionOutbox_uploaderId_idx" ON "ReceiptExtractionOutbox"("uploaderId");

-- AddForeignKey
ALTER TABLE "ReceiptExtractionOutbox" ADD CONSTRAINT "ReceiptExtractionOutbox_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptExtractionOutbox" ADD CONSTRAINT "ReceiptExtractionOutbox_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
