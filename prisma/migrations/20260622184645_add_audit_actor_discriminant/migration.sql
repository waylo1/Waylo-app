-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('ADMIN', 'SYSTEM');

-- AlterTable
ALTER TABLE "AdminAuditLog" ADD COLUMN     "actor" "AuditActor" NOT NULL DEFAULT 'ADMIN';
