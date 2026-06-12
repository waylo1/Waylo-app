"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { ApiError } from "@/lib/api";
import { eurToCents } from "@/lib/money";
import { RequireAuth } from "@/components/require-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// NOTE backend : le modèle Mission n'a PAS de colonne `description` distincte.
// Titre + description sont fusionnés dans `targetProduct` (max 500 caractères).

const ERROR_LABELS: Record<string, string> = {
  INVALID_INPUT: "Champs invalides — vérifiez le formulaire.",
  EXPIRES_AT_IN_PAST: "La date d'expiration doit être dans le futur.",
};

export default function CreateMissionPage() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState("");
  const [commission, setCommission] = useState("");
  const [destination, setDestination] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const budgetCents = eurToCents(budget);
    if (budgetCents === null || budgetCents <= 0) {
      return setError("Budget invalide (ex. : 120 ou 120,50).");
    }
    const commissionCents = commission.trim() === "" ? 0 : eurToCents(commission);
    if (commissionCents === null) {
      return setError("Commission invalide (ex. : 10 ou 10,50).");
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      return setError("La date d'expiration doit être dans le futur.");
    }
    const targetProduct = description.trim()
      ? `${title.trim()} — ${description.trim()}`
      : title.trim();
    if (targetProduct.length === 0 || targetProduct.length > 500) {
      return setError("Titre + description : entre 1 et 500 caractères.");
    }

    setPending(true);
    try {
      const mission = await api.createMission({
        targetProduct,
        budgetCents,
        commissionCents,
        destination: destination.trim(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      router.push(`/missions/${mission.id}/pay`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? (ERROR_LABELS[err.code] ?? `Erreur : ${err.code}`)
          : "Erreur réseau.",
      );
      setPending(false);
    }
  }

  return (
    <RequireAuth>
      <div className="mx-auto max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Nouvelle mission</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="title">Titre (produit recherché)</Label>
                <Input
                  id="title"
                  required
                  maxLength={200}
                  placeholder="iPhone 16 Pro 256 Go"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description (facultatif)</Label>
                <textarea
                  id="description"
                  className="flex min-h-20 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  maxLength={290}
                  placeholder="Couleur, référence exacte, magasin conseillé…"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="budget">Budget (€)</Label>
                  <Input
                    id="budget"
                    required
                    inputMode="decimal"
                    placeholder="1200,00"
                    value={budget}
                    onChange={e => setBudget(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="commission">Commission voyageur (€)</Label>
                  <Input
                    id="commission"
                    inputMode="decimal"
                    placeholder="50,00"
                    value={commission}
                    onChange={e => setCommission(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="destination">Destination</Label>
                <Input
                  id="destination"
                  required
                  maxLength={200}
                  placeholder="Tokyo, Japon"
                  value={destination}
                  onChange={e => setDestination(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="expiresAt">Expire le</Label>
                <Input
                  id="expiresAt"
                  type="datetime-local"
                  required
                  value={expiresAt}
                  onChange={e => setExpiresAt(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={pending}>
                {pending ? "Création…" : "Créer la mission"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </RequireAuth>
  );
}
