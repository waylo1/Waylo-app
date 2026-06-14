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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Suivi ACHETEUR d'une mission. Vue dédiée par statut ; à AWAITING_VALIDATION,
// la validation T1 (POST /validate) déclenche la capture du séquestre — le
// webhook payment_intent.succeeded finalise ensuite VALIDATED → RELEASED.
// GET /missions/:id joint le reçu scellé sous `receipt` : l'acheteur voit le
// montant payé et le justificatif avant de confirmer.

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
        {mission.receipt ? (
          <div className="space-y-1 rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">
              Montant payé par le voyageur :{" "}
              {centsToEur(mission.receipt.totalTtcCents)}
            </p>
            <p className="text-xs text-muted-foreground">
              Reçu scellé le{" "}
              {new Date(mission.receipt.sealedAt).toLocaleString("fr-FR")}
            </p>
            {mission.receipt.receiptUrl && (
              <a
                href={mission.receipt.receiptUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm underline underline-offset-4"
              >
                Voir le reçu
              </a>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Reçu scellé indisponible — rechargez la page ou contactez le
            support avant de valider.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          En confirmant, vous déclenchez la capture du séquestre (
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

function ShipForm({
  mission,
  onShipped,
}: {
  mission: Mission;
  onShipped: (m: Mission) => void;
}) {
  const [trackingReference, setTrackingReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ref = trackingReference.trim();
    if (!ref) return setError("Référence de suivi requise.");
    setPending(true);
    setError(null);
    try {
      onShipped(await api.shipMission(mission.id, ref));
    } catch (err) {
      setError(apiErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Déclarer le dépôt/expédition</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="trackingReference">Référence de suivi</Label>
            <Input
              id="trackingReference"
              required
              maxLength={200}
              placeholder="1Z999AA10123456784"
              value={trackingReference}
              onChange={e => setTrackingReference(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Envoi…" : "Déclarer le dépôt/expédition"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ReceiveCard({
  mission,
  onReceived,
}: {
  mission: Mission;
  onReceived: (m: Mission) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleReceive() {
    setPending(true);
    setError(null);
    try {
      onReceived(await api.receiveMission(mission.id));
    } catch (err) {
      setError(apiErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Réception du colis</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          Référence de suivi :{" "}
          <span className="font-medium">{mission.trackingReference ?? "—"}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          En confirmant la réception, vous déclenchez la capture du séquestre (
          {centsToEur(mission.budgetCents + mission.commissionCents)}) et la
          libération des fonds au voyageur. Cette action est définitive.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button className="w-full" disabled={pending} onClick={handleReceive}>
          {pending ? "Confirmation…" : "Confirmer la réception"}
        </Button>
      </CardContent>
    </Card>
  );
}

function CustomsReceiptForm({
  mission,
  onCleared,
}: {
  mission: Mission;
  onCleared: (m: Mission) => void;
}) {
  const [customsReceiptUrl, setCustomsReceiptUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const url = customsReceiptUrl.trim();
    if (!url) return setError("Lien de la quittance requis.");
    setPending(true);
    setError(null);
    try {
      onCleared(await api.submitCustomsReceipt(mission.id, url));
    } catch (err) {
      setError(apiErrorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quittance douanière requise</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          La valeur déclarée dépasse le seuil douanier de destination.
          Téléversez votre preuve de paiement des taxes pour lever le verrou.
        </p>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="customsReceiptUrl">Lien de la quittance</Label>
            <Input
              id="customsReceiptUrl"
              required
              maxLength={2048}
              placeholder="https://…"
              value={customsReceiptUrl}
              onChange={e => setCustomsReceiptUrl(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Envoi…" : "Téléverser la quittance"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MissionDetail({ missionId }: { missionId: string }) {
  const { user } = useAuth();
  const [mission, setMission] = useState<Mission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justValidated, setJustValidated] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMission(missionId)
      .then(setMission)
      .catch(err =>
        setError(apiErrorMessage(err, "Impossible de charger la mission.")),
      );
  }, [missionId]);

  // Acceptation du transport (voyageur) : FUNDED -> MATCHED. Le succès remplace
  // la mission en state → la vue bascule sur l'état « voyageur assigné ».
  async function handleAccept(id: string) {
    setAccepting(true);
    setAcceptError(null);
    try {
      setMission(await api.acceptMission(id));
    } catch (err) {
      setAcceptError(apiErrorMessage(err, "Échec de l'acceptation."));
      setAccepting(false);
    }
  }

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
        <CardContent className="space-y-2 text-sm">
          <p className="text-base font-medium">{mission.targetProduct}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="font-medium">Origine</dt>
            <dd className="text-muted-foreground">{mission.origin}</dd>
            <dt className="font-medium">Destination</dt>
            <dd className="text-muted-foreground">{mission.destination}</dd>
            <dt className="font-medium">Budget</dt>
            <dd className="text-muted-foreground">
              {centsToEur(mission.budgetCents)}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            Marge Voyageur {centsToEur(mission.commissionCents)} · expire le{" "}
            {new Date(mission.expiresAt).toLocaleDateString("fr-FR")}
          </p>
        </CardContent>
      </Card>

      {!isBuyer ? (
        mission.status === "FUNDED" ? (
          <div className="space-y-3">
            {/* Bouton principal — actif si connecté et mission FUNDED. */}
            <Button
              className="w-full"
              disabled={!user || accepting}
              onClick={() => handleAccept(mission.id)}
            >
              {accepting ? "Acceptation…" : "Accepter le transport de ce colis"}
            </Button>
            {acceptError && (
              <p className="text-sm text-destructive">{acceptError}</p>
            )}
          </div>
        ) : mission.status === "MATCHED" && user?.id === mission.travelerId ? (
          <ShipForm mission={mission} onShipped={setMission} />
        ) : mission.status === "ESCROW_LOCKED_CUSTOMS" ? (
          <CustomsReceiptForm mission={mission} onCleared={setMission} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Vous êtes le Voyageur Importateur de cette mission —{" "}
            <Link
              href={`/missions/${mission.id}/dashboard`}
              className="underline underline-offset-4"
            >
              ouvrir le tableau de bord voyageur
            </Link>
            .
          </p>
        )
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
      ) : mission.status === "ESCROW_LOCKED_CUSTOMS" ? (
        <Card>
          <CardContent className="space-y-2 py-4">
            <p className="text-sm font-medium text-destructive">
              Mission bloquée en douane
            </p>
            <p className="text-sm text-muted-foreground">
              La valeur déclarée dépasse le seuil douanier de destination. Les
              fonds restent séquestrés tant que le voyageur n&apos;a pas fourni
              la quittance de paiement des taxes.
            </p>
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
      ) : mission.status === "IN_PROGRESS" ? (
        <ReceiveCard
          mission={mission}
          onReceived={m => {
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
