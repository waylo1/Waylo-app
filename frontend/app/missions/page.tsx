"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as api from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { centsToEur } from "@/lib/money";
import type { Mission } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { RequireAuth } from "@/components/require-auth";
import { MissionStatusBadge } from "@/components/mission-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

function MissionList() {
  const { user } = useAuth();
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listMyMissions()
      .then(setMissions)
      .catch(err =>
        setError(apiErrorMessage(err, "Impossible de charger les missions.")),
      );
  }, []);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!missions)
    return <p className="text-sm text-muted-foreground">Chargement…</p>;

  return (
    <div className="space-y-3">
      {missions.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucune mission pour l&apos;instant.
        </p>
      )}
      {missions.map(mission => {
        const isBuyer = user?.id === mission.buyerId;
        return (
          <Card key={mission.id}>
            <CardContent className="flex items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <p className="truncate font-medium">{mission.targetProduct}</p>
                <p className="text-sm text-muted-foreground">
                  {mission.destination} · budget {centsToEur(mission.budgetCents)}{" "}
                  · {isBuyer ? "vous êtes l'acheteur" : "vous êtes le voyageur"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <MissionStatusBadge status={mission.status} />
                {isBuyer && mission.status === "CREATED" && (
                  <Button
                    size="sm"
                    render={<Link href={`/missions/${mission.id}/pay`} />}
                  >
                    Financer
                  </Button>
                )}
                {isBuyer ? (
                  <Button
                    size="sm"
                    variant={
                      mission.status === "AWAITING_VALIDATION"
                        ? "default"
                        : "outline"
                    }
                    render={<Link href={`/missions/${mission.id}`} />}
                  >
                    {mission.status === "AWAITING_VALIDATION"
                      ? "Valider la réception"
                      : "Suivi"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    render={
                      <Link href={`/missions/${mission.id}/dashboard`} />
                    }
                  >
                    Tableau de bord
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default function MissionsPage() {
  return (
    <RequireAuth>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Mes missions</h1>
        <Button render={<Link href="/missions/create" />}>
          Nouvelle mission
        </Button>
      </div>
      <MissionList />
    </RequireAuth>
  );
}
