-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripePaymentMethodId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_stripePaymentMethodId_key" ON "User"("stripePaymentMethodId");
