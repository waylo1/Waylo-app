import { Badge } from "@/components/ui/badge";
import type { MissionStatus } from "@/lib/types";

// Libellés FR + variante visuelle par statut (miroir de l'enum Prisma).
const STATUS_CONFIG: Record<
  MissionStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  CREATED: { label: "Créée", variant: "outline" },
  FUNDED: { label: "Financée", variant: "secondary" },
  MATCHED: { label: "Voyageur assigné", variant: "secondary" },
  IN_PROGRESS: { label: "En cours", variant: "default" },
  ESCROW_LOCKED_CUSTOMS: { label: "Bloquée (douane)", variant: "destructive" },
  AWAITING_VALIDATION: { label: "En attente de validation", variant: "default" },
  VALIDATED: { label: "Validée", variant: "default" },
  AWAITING_TRAVELER_ACCOUNT: {
    label: "Compte voyageur requis",
    variant: "destructive",
  },
  RELEASED: { label: "Fonds libérés", variant: "secondary" },
  REFUNDED: { label: "Remboursée", variant: "destructive" },
  CANCELLED: { label: "Annulée", variant: "destructive" },
};

export function MissionStatusBadge({ status }: { status: MissionStatus }) {
  const { label, variant } = STATUS_CONFIG[status];
  return <Badge variant={variant}>{label}</Badge>;
}
