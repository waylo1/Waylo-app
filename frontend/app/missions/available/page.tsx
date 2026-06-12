"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { centsToEur } from "@/lib/money";
import type { Mission } from "@/lib/types";
import { RequireAuth } from "@/components/require-auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

function AvailableList() {
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [matchingId, setMatchingId] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    api
      .listAvailableMissions()
      .then(setMissions)
      .catch(err =>
        setError(apiErrorMessage(err, "Impossible de charger le catalogue.")),
      );
  }, []);

  async function handleMatch(missionId: string) {
    setMatchingId(missionId);
    setError(null);
    try {
      await api.matchMission(missionId);
      // Redirection immédiate vers le tableau de bord voyageur de la mission.
      router.push(`/missions/${missionId}/dashboard`);
    } catch (err) {
      setError(apiErrorMessage(err, "Échec de l'acceptation de la mission."));
      // Mission déjà prise : on la retire du catalogue affiché.
      if (err instanceof ApiError && err.code === "MISSION_ALREADY_MATCHED") {
        setMissions(prev => prev?.filter(m => m.id !== missionId) ?? null);
      }
      setMatchingId(null);
    }
  }

  if (error && !missions)
    return <p className="text-sm text-destructive">{error}</p>;
  if (!missions)
    return <p className="text-sm text-muted-foreground">Chargement…</p>;

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {missions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune mission disponible pour le moment.
        </p>
      )}
      {missions.map(mission => (
        <Card key={mission.id}>
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0">
              <p className="truncate font-medium">{mission.targetProduct}</p>
              <p className="text-sm text-muted-foreground">
                {mission.destination} · budget{" "}
                {centsToEur(mission.budgetCents)} · commission{" "}
                {centsToEur(mission.commissionCents)} · expire le{" "}
                {new Date(mission.expiresAt).toLocaleDateString("fr-FR")}
              </p>
            </div>
            <Button
              className="shrink-0"
              disabled={matchingId !== null}
              onClick={() => handleMatch(mission.id)}
            >
              {matchingId === mission.id ? "…" : "Accepter la mission"}
            </Button>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function AvailableMissionsPage() {
  return (
    <RequireAuth>
      <h1 className="mb-6 text-xl font-semibold">Catalogue des missions</h1>
      <AvailableList />
    </RequireAuth>
  );
}
