-- [WATCHDOG] Ajout du champ autoRefundDeadline et de son index composite pour le Watchdog auto-refund.
-- Posé à /ship (now + 72 h) ; triggerAutoRefundWatchdog interroge cet index pour
-- identifier les missions IN_PROGRESS en dépassement sans preuve de livraison voyageur.

-- 1) Champ nullable : aucun backfill requis (missions existantes = null → exclues du watchdog).
ALTER TABLE "Mission" ADD COLUMN "autoRefundDeadline" TIMESTAMP(3);

-- 2) Index composite (status, autoRefundDeadline) : élimine les lignes non-IN_PROGRESS
--    avant le range-scan sur la deadline — même pattern que (status, expiresAt).
CREATE INDEX "idx_auto_refund" ON "Mission"("status", "autoRefundDeadline");
