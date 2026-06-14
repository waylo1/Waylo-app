"use client";

import { useState } from "react";
import * as api from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { centsToEur, eurToCents } from "@/lib/money";
import type { Mission } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Composant client (state + events) — cf. Next 16 `use client`. Réutilisable :
// la page /missions/create le consomme.

// Commission voyageur = pourcentage FIGÉ du budget (frais plateforme CALCULÉ,
// jamais saisi). Centimes Int : Math.round sur le produit, jamais de Float.
export const COMMISSION_RATE = 0.1;

export function computeCommissionCents(budgetCents: number): number {
  return Math.round(budgetCents * COMMISSION_RATE);
}

export interface MissionFormProps {
  /**
   * Appelé après création réussie (parent client → enfant client : prop fonction
   * autorisée). Défaut : ouvre la session Stripe Checkout et y redirige.
   */
  onCreated?: (mission: Mission) => void;
}

export function MissionForm({ onCreated }: MissionFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [budget, setBudget] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Commission dérivée du budget saisi, affichée en direct. null tant que le
  // budget est invalide/vide → la cellule affiche « — ».
  const parsedBudgetCents = eurToCents(budget);
  const previewCommissionCents =
    parsedBudgetCents !== null && parsedBudgetCents > 0
      ? computeCommissionCents(parsedBudgetCents)
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // origine : validée puis ENVOYÉE — colonne `origin` persistée côté backend
    // (migration add_origin_to_mission), requise par createMissionBodySchema (min 1).
    const originTrimmed = origin.trim();
    if (originTrimmed.length === 0 || originTrimmed.length > 200) {
      return setError("Origine : entre 1 et 200 caractères.");
    }
    const destinationTrimmed = destination.trim();
    if (destinationTrimmed.length === 0 || destinationTrimmed.length > 200) {
      return setError("Destination : entre 1 et 200 caractères.");
    }
    const budgetCents = eurToCents(budget);
    if (budgetCents === null || budgetCents <= 0) {
      return setError("Budget invalide (ex. : 120 ou 120,50).");
    }
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      return setError("La date d'expiration doit être dans le futur.");
    }
    // Titre + description fusionnés dans targetProduct (le backend n'a pas de
    // colonne description distincte ; max 500 caractères).
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
        commissionCents: computeCommissionCents(budgetCents),
        origin: originTrimmed,
        destination: destinationTrimmed,
        expiresAt: new Date(expiresAtMs).toISOString(),
      });
      // Override parent éventuel ; sinon financement T0 via Stripe Checkout :
      // on ouvre la session et on redirige vers la page hébergée Stripe.
      if (onCreated) {
        onCreated(mission);
      } else {
        const { checkoutUrl } = await api.createCheckoutSession(mission.id);
        if (!checkoutUrl) {
          return setError("Session de paiement indisponible — réessayez.");
        }
        window.location.href = checkoutUrl; // redirection plein écran vers Stripe
        return; // navigation en cours : ne pas réactiver le bouton
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      // Réactive le bouton dans tous les cas — y compris le chemin réutilisable
      // où `onCreated` ne démonte pas le formulaire (sinon il reste « Création… »).
      setPending(false);
    }
  }

  return (
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
          <Label htmlFor="origin">Origine</Label>
          <Input
            id="origin"
            required
            maxLength={200}
            placeholder="Paris, France"
            value={origin}
            onChange={e => setOrigin(e.target.value)}
          />
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
          <Label htmlFor="commission">
            Marge Voyageur ({Math.round(COMMISSION_RATE * 100)} %)
          </Label>
          <Input
            id="commission"
            readOnly
            tabIndex={-1}
            aria-label="Commission calculée"
            className="bg-muted/50"
            value={
              previewCommissionCents !== null
                ? centsToEur(previewCommissionCents)
                : "—"
            }
          />
        </div>
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
  );
}
