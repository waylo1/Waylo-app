-- Index de matching global « Net Gain » (matching.service.getAvailableMatches).
-- Requête : WHERE "status" = 'FUNDED' ORDER BY "commissionCents" DESC, "createdAt" DESC.
-- L'ORDER BY mène sur "commissionCents" : l'index existant (status, createdAt) ne
-- couvre pas ce tri. Index aligné sur le tri réel ⇒ parcours déjà ordonné (pas de tri en RAM).
CREATE INDEX "idx_net_gain_matching" ON "Mission"("status", "commissionCents" DESC, "createdAt" DESC);
