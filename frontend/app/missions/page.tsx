"use client";

import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { centsToEur } from "@/lib/money";
import type { Mission } from "@/lib/types";
import { RequireAuth } from "@/components/require-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Catalogue des missions FUNDED à pourvoir, filtrable par origine/destination.
function FundedMissions() {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .listAvailableMissions({ origin: origin.trim(), destination: destination.trim() })
      .then(setMissions)
      .catch(err =>
        setError(apiErrorMessage(err, "Impossible de charger les missions.")),
      );
  }, [origin, destination]);

  // Chargement initial (sans filtre) ; les filtres se relancent à la soumission.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFilter(e: React.FormEvent) {
    e.preventDefault();
    load();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleFilter} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="f-origin">Origine</Label>
          <Input
            id="f-origin"
            placeholder="Paris"
            value={origin}
            onChange={e => setOrigin(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="f-destination">Destination</Label>
          <Input
            id="f-destination"
            placeholder="Tokyo"
            value={destination}
            onChange={e => setDestination(e.target.value)}
          />
        </div>
        <Button type="submit">Filtrer</Button>
      </form>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!missions ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : missions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucune mission ne correspond.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {missions.map(mission => (
            <Card key={mission.id}>
              <CardHeader>
                <CardTitle className="truncate">
                  {mission.targetProduct}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm text-muted-foreground">
                <p>Origine : {mission.origin}</p>
                <p>Destination : {mission.destination}</p>
                <p>Budget : {centsToEur(mission.budgetCents)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MissionsPage() {
  return (
    <RequireAuth>
      <h1 className="mb-6 text-xl font-semibold">Missions à pourvoir</h1>
      <FundedMissions />
    </RequireAuth>
  );
}
