-- AlterEnum
-- CONSUMED : job dont le reçu extrait a été validé (anti-fraude) puis scellé (Receipt créé).
-- Inséré APRÈS 'COMPLETED' pour aligner l'ordre DB sur l'ordre du schéma Prisma (zéro dérive).
ALTER TYPE "ReceiptJobStatus" ADD VALUE 'CONSUMED' AFTER 'COMPLETED';
