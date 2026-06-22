-- Vérification de la preuve de livraison + isolation des logs système.
--
-- 1. DeliveryProofStatus : source de vérité pour la pénalité d'instruction —
--    VALIDATED = livraison prouvée → contestation potentiellement abusive.
-- 2. Mission.deliveryProofStatus : défaut PENDING = bonne foi = jamais de pénalité.
-- 3. Rename PenaltyReason ABUSIVE_DISPUTE → ABUSIVE_CONTESTATION (PG 10+, Supabase 15).
-- 4. AdminAuditLog.adminId nullable : autorise les entrées SYSTÈME (worker, sans admin).

-- CreateEnum : cycle de vie de la preuve de livraison.
CREATE TYPE "DeliveryProofStatus" AS ENUM ('PENDING', 'VALIDATED', 'REJECTED');

-- AlterTable : champ deliveryProofStatus sur Mission (défaut PENDING).
ALTER TABLE "Mission" ADD COLUMN "deliveryProofStatus" "DeliveryProofStatus" NOT NULL DEFAULT 'PENDING';

-- AlterEnum : renomme la valeur pour refléter la source de vérité (deliveryProofStatus).
-- RENAME VALUE est supporté depuis PostgreSQL 10 (Supabase >= PG 15).
ALTER TYPE "PenaltyReason" RENAME VALUE 'ABUSIVE_DISPUTE' TO 'ABUSIVE_CONTESTATION';

-- AlterTable : adminId nullable → entrées SYSTÈME sans intervention humaine autorisées.
ALTER TABLE "AdminAuditLog" ALTER COLUMN "adminId" DROP NOT NULL;
