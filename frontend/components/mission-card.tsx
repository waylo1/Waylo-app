import { centsToEur } from "@/lib/money";
import type { Mission } from "@/lib/types";
import { MissionStatusBadge } from "@/components/mission-status-badge";
import { QuickActions } from "@/components/quick-actions";
import { Card, CardContent } from "@/components/ui/card";

interface MissionCardProps {
  mission: Mission;
  userId?: string | null;
  onMatch?: (id: string) => void;
  matchingId?: string | null;
}

export function MissionCard({
  mission,
  userId,
  onMatch,
  matchingId,
}: MissionCardProps) {
  return (
    <Card data-testid="mission-card">
      <CardContent className="space-y-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate font-medium">{mission.targetProduct}</p>
          <MissionStatusBadge status={mission.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {mission.origin} → {mission.destination} ·{" "}
          {centsToEur(mission.budgetCents)}
        </p>
        <QuickActions
          mission={mission}
          userId={userId}
          onMatch={onMatch}
          matchingId={matchingId}
        />
      </CardContent>
    </Card>
  );
}
