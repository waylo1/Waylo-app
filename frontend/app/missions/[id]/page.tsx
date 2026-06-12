"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import * as api from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { centsToEur } from "@/lib/money";
import type { Mission } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { RequireAuth } from "@/components/require-auth";
import { MissionStatusBadge } from "@/components/mission-status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Suivi ACHETEUR d'une mission. Vue dédiée par statut ; à AWAITING_VALIDATION,
// la validation T1 (POST /validate) déclenche la capture du séquestre — le
// webhook payment_intent.succeeded finalise ensuite VALIDATED → RELEASED.
// Limitation V1 : pas de route API de lecture du reçu scellé — l'acheteur
// valide sans voir le montant TTC déposé (à exposer côté backend plus tard).

const STATUS_HINTS: Partial<Record<Mission["status"], string>> = {
  CREATED: "Mission créée — financez-la pour la publier au catalogue.",
  FUNDED: "Fonds séquestrés. En attente qu'un voyageur accepte la mission.",
  MATCHED: "Un voyageur a accepté la mission et va démarrer son voyage.",
  IN_PROGRESS: "Le voyageur est en mission — l'achat est en cours.",
  AWAITING_TRAVELER_ACCOUNT:
    "Fonds capturés, versement en attente du compte voyageur — le support est sur le coup.",
  REFUNDED: "Mission remboursée.",
  CANCELLED: "Mission annulée.",
};

function ValidationCard({
  mission,
  onValidated,
}: {
  mission: Mission;
  onValidated: (m: Mission) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleValidate() {
    setPending(true);
    setError(null);
    try {
      onValidated(await api.validateMission(mission.id));
    } catch (err) {
      setError(apiErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Validation de la réception</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Le voyageur a scellé son reçu d&apos;achat. En confirmant, vous
          déclenchez la capture du séquestre (
          {centsToEur(mission.budgetCents + mission.commissionCents)}) et la
          libération des fonds au voyageur. Cette action est définitive.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button className="w-full" disabled={pending} onClick={handleValidate}>
          {pending
            ? "Validation en cours…"
            : "Confirmer la réception et libérer les fonds"}
        </Button>
      </CardContent>
    </Card>
  );
}

function MissionDetail({ missionId }: { missionId: string }) {
  const { user } = useAuth();
  const [mission, setMission] = useState<Mission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justValidated, setJustValidated] = useState(false);

  useEffect(() => {
    api
      .getMission(missionId)
      .then(setMission)
      .catch(err =>
        setError(apiErrorMessage(err, "Impossible de charger la mission.")),
      );
  }, [missionId]);

  if (error && !mission)
    return <p className="text-sm text-destructive">{error}</p>;
  if (!mission)
    return <p className="text-sm text-muted-foreground">Chargement…</p>;

  const isBuyer = user?.id === mission.buyerId;
  const fundsReleased =
    mission.status === "VALIDATED" || mission.status === "RELEASED";

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Suivi de mission</CardTitle>
            <MissionStatusBadge status={mission.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="font-medium">{mission.targetProduct}</p>
          <p className="text-muted-foreground">{mission.destination}</p>
          <p className="text-muted-foreground">
            Budget {centsToEur(mission.budgetCents)} · commission{" "}
            {centsToEur(mission.commissionCents)} · expire le{" "}
            {new Date(mission.expiresAt).toLocaleDateString("fr-FR")}
          </p>
        </CardContent>
      </Card>

      {!isBuyer ? (
        <p className="text-sm text-muted-foreground">
          Vous êtes le voyageur de cette mission —{" "}
          <Link
            href={`/missions/${mission.id}/dashboard`}
            className="underline underline-offset-4"
          >
            ouvrir le tableau de bord voyageur
          </Link>
          .
        </p>
      ) : fundsReleased ? (
        <Card>
          <CardContent className="space-y-2 py-4">
            <p className="text-sm font-medium text-green-700">
              {justValidated || mission.status === "VALIDATED"
                ? "Réception confirmée — capture des fonds déclenchée, libération au voyageur en cours."
                : "Fonds libérés au voyageur. Mission terminée."}
            </p>
            <Button variant="outline" render={<Link href="/missions" />}>
              Retour à mes missions
            </Button>
          </CardContent>
        </Card>
      ) : mission.status === "AWAITING_VALIDATION" ? (
        <ValidationCard
          mission={mission}
          onValidated={m => {
            setMission(m);
            setJustValidated(true);
          }}
        />
      ) : (
        <div className="space-y-3">
          {STATUS_HINTS[mission.status] && (
            <p className="text-sm text-muted-foreground">
              {STATUS_HINTS[mission.status]}
            </p>
          )}
          {mission.status === "CREATED" && (
            <Button render={<Link href={`/missions/${mission.id}/pay`} />}>
              Financer la mission
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default function MissionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <RequireAuth>
      <MissionDetail missionId={id} />
    </RequireAuth>
  );
}
