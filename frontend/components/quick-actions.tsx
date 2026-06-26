"use client";

import Link from "next/link";
import type { Mission } from "@/lib/types";
import { Button } from "@/components/ui/button";

interface QuickActionsProps {
  mission: Mission;
  userId?: string | null;
  onMatch?: (id: string) => void;
  matchingId?: string | null;
}

export function QuickActions({
  mission,
  userId,
  onMatch,
  matchingId,
}: QuickActionsProps) {
  const isBuyer = userId != null && userId === mission.buyerId;
  const isTraveler = userId != null && userId === mission.travelerId;

  if (isBuyer && mission.status === "CREATED") {
    return (
      <Button size="sm" render={<Link href={`/missions/${mission.id}/pay`} />}>
        Financer
      </Button>
    );
  }

  if (!isBuyer && mission.status === "FUNDED" && onMatch) {
    return (
      <Button
        size="sm"
        disabled={matchingId !== null}
        onClick={() => onMatch(mission.id)}
      >
        {matchingId === mission.id ? "…" : "Accepter"}
      </Button>
    );
  }

  if (isBuyer && mission.status === "AWAITING_VALIDATION") {
    return (
      <Button
        size="sm"
        render={<Link href={`/missions/${mission.id}`} />}
      >
        Valider réception
      </Button>
    );
  }

  if (isTraveler && mission.status === "MATCHED") {
    return (
      <Button
        size="sm"
        render={<Link href={`/missions/${mission.id}/dashboard`} />}
      >
        Tableau de bord
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      render={<Link href={`/missions/${mission.id}`} />}
    >
      Voir
    </Button>
  );
}
