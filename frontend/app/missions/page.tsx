"use client";

import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import type { Mission } from "@/lib/types";
import { RequireAuth } from "@/components/require-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MissionList } from "@/components/mission-list";

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
      <MissionList
        missions={missions}
        error={error}
        emptyMessage="Aucune mission ne correspond."
      />
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
