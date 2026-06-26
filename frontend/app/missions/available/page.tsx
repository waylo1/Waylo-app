"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import type { Mission } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { RequireAuth } from "@/components/require-auth";
import { MissionList } from "@/components/mission-list";

function AvailableList() {
  const { user } = useAuth();
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
      router.push(`/missions/${missionId}/dashboard`);
    } catch (err) {
      setError(apiErrorMessage(err, "Échec de l'acceptation de la mission."));
      if (err instanceof ApiError && err.code === "MISSION_ALREADY_MATCHED") {
        setMissions(prev => prev?.filter(m => m.id !== missionId) ?? null);
      }
      setMatchingId(null);
    }
  }

  return (
    <MissionList
      missions={missions}
      error={error}
      emptyMessage="Aucune mission disponible pour le moment."
      userId={user?.id}
      onMatch={handleMatch}
      matchingId={matchingId}
    />
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
