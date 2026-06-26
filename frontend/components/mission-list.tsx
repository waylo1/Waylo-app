import type { Mission } from "@/lib/types";
import { MissionCard } from "@/components/mission-card";

interface MissionListProps {
  missions: Mission[] | null;
  error?: string | null;
  emptyMessage?: string;
  userId?: string | null;
  onMatch?: (id: string) => void;
  matchingId?: string | null;
}

export function MissionList({
  missions,
  error,
  emptyMessage = "Aucune mission.",
  userId,
  onMatch,
  matchingId,
}: MissionListProps) {
  if (error && !missions) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!missions) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="missions-loading">
        Chargement…
      </p>
    );
  }
  if (missions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="missions-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {missions.map(m => (
        <MissionCard
          key={m.id}
          mission={m}
          userId={userId}
          onMatch={onMatch}
          matchingId={matchingId}
        />
      ))}
    </div>
  );
}
