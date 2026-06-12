"use client";

import { use, useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import { centsToEur, eurToCents } from "@/lib/money";
import type { Mission } from "@/lib/types";
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

// Tableau de bord VOYAGEUR : démarrer le voyage (MATCHED → IN_PROGRESS) puis
// déposer le reçu scellé (IN_PROGRESS → AWAITING_VALIDATION). Le reçu est
// immuable côté backend — un seul dépôt possible.

function ReceiptForm({
  mission,
  onSubmitted,
}: {
  mission: Mission;
  onSubmitted: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const purchaseAmountCents = eurToCents(amount);
    if (purchaseAmountCents === null || purchaseAmountCents <= 0) {
      return setError("Montant TTC invalide (ex. : 1150,90).");
    }
    if (purchaseAmountCents > mission.budgetCents) {
      return setError(
        `Le montant dépasse le budget de la mission (${centsToEur(mission.budgetCents)}).`,
      );
    }

    setPending(true);
    try {
      await api.submitReceipt(mission.id, {
        urlRecu: receiptUrl.trim(),
        purchaseAmountCents,
      });
      onSubmitted();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setError(
        code === "RECEIPT_AMOUNT_EXCEEDS_BUDGET"
          ? "Le montant dépasse le budget de la mission."
          : code === "RECEIPT_ALREADY_SUBMITTED"
            ? "Un reçu a déjà été scellé pour cette mission."
            : code === "MISSION_NOT_IN_PROGRESS"
              ? "La mission n'est plus en cours — reçu refusé."
              : `Échec du dépôt du reçu${code ? ` : ${code}` : "."}`,
      );
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="amount">Montant TTC de l&apos;achat (€)</Label>
        <Input
          id="amount"
          required
          inputMode="decimal"
          placeholder="1150,90"
          value={amount}
          onChange={e => setAmount(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Plafond : {centsToEur(mission.budgetCents)} (budget figé de la
          mission).
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="receiptUrl">URL du reçu</Label>
        <Input
          id="receiptUrl"
          required
          type="url"
          maxLength={2048}
          placeholder="https://…/recu.jpg"
          value={receiptUrl}
          onChange={e => setReceiptUrl(e.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Scellement…" : "Déposer le reçu"}
      </Button>
    </form>
  );
}

function DashboardContent({ missionId }: { missionId: string }) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const reload = useCallback(() => {
    api
      .getMission(missionId)
      .then(setMission)
      .catch(err =>
        setError(
          err instanceof ApiError && err.code === "MISSION_NOT_FOUND"
            ? "Mission introuvable."
            : "Impossible de charger la mission.",
        ),
      );
  }, [missionId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleStartTravel() {
    setPending(true);
    setError(null);
    try {
      setMission(await api.startTravel(missionId));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      setError(
        code === "MISSION_NOT_MATCHED"
          ? "La mission n'est pas (ou plus) au statut « voyageur assigné »."
          : `Échec du démarrage du voyage${code ? ` : ${code}` : "."}`,
      );
    } finally {
      setPending(false);
    }
  }

  if (error && !mission)
    return <p className="text-sm text-destructive">{error}</p>;
  if (!mission)
    return <p className="text-sm text-muted-foreground">Chargement…</p>;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Mission</CardTitle>
            <MissionStatusBadge status={mission.status} />
          </div>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="font-medium">{mission.targetProduct}</p>
          <p className="text-muted-foreground">{mission.destination}</p>
          <p className="text-muted-foreground">
            Budget {centsToEur(mission.budgetCents)} · commission{" "}
            {centsToEur(mission.commissionCents)}
          </p>
        </CardContent>
      </Card>

      {mission.status === "MATCHED" && (
        <Card>
          <CardHeader>
            <CardTitle>Étape suivante</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              className="w-full"
              disabled={pending}
              onClick={handleStartTravel}
            >
              {pending ? "…" : "Démarrer le voyage"}
            </Button>
          </CardContent>
        </Card>
      )}

      {mission.status === "IN_PROGRESS" && (
        <Card>
          <CardHeader>
            <CardTitle>Dépôt du reçu d&apos;achat</CardTitle>
          </CardHeader>
          <CardContent>
            <ReceiptForm mission={mission} onSubmitted={reload} />
          </CardContent>
        </Card>
      )}

      {mission.status === "AWAITING_VALIDATION" && (
        <p className="text-sm text-muted-foreground">
          Reçu scellé. En attente de la validation de l&apos;acheteur — la
          libération des fonds suivra.
        </p>
      )}
    </div>
  );
}

export default function MissionDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <RequireAuth>
      <DashboardContent missionId={id} />
    </RequireAuth>
  );
}
