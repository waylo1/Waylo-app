-- CreateIndex
CREATE INDEX "Mission_status_expiresAt_idx" ON "Mission"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Penalty_status_attempts_idx" ON "Penalty"("status", "attempts");
