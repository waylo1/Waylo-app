"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";
import * as api from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { centsToEur } from "@/lib/money";
import type { IntentResponse, Mission } from "@/lib/types";
import { RequireAuth } from "@/components/require-auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Financement T0 : POST /intent crée le PaymentIntent (capture différée) et
// renvoie le clientSecret. L'appel est déclenché par un CLIC explicite, jamais
// au mount (StrictMode double les effets → le 2e appel verrait
// MISSION_ALREADY_FUNDED). Limitation V1 : le clientSecret n'est pas
// re-récupérable après coup — si la page est quittée entre intent et paiement,
// la mission reste FUNDED côté API sans autorisation carte.

const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
const stripePromise: Promise<Stripe | null> | null = publishableKey
  ? loadStripe(publishableKey)
  : null;

function CheckoutForm({ amountCents }: { amountCents: number }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setPending(true);
    setError(null);
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: "if_required",
    });
    if (result.error) {
      setError(result.error.message ?? "Échec du paiement.");
      setPending(false);
      return;
    }
    // capture_method: manual → l'autorisation réussie laisse le PI en
    // requires_capture : les fonds sont séquestrés, pas encore capturés.
    setSucceeded(true);
    setPending(false);
  }

  if (succeeded) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium text-green-700">
          Fonds séquestrés ({centsToEur(amountCents)}). La capture aura lieu
          après validation de la mission.
        </p>
        <Button variant="outline" render={<Link href="/missions" />}>
          Retour à mes missions
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={!stripe || pending}>
        {pending ? "Paiement…" : `Séquestrer ${centsToEur(amountCents)}`}
      </Button>
    </form>
  );
}

function PayContent({ missionId }: { missionId: string }) {
  const [mission, setMission] = useState<Mission | null>(null);
  const [intent, setIntent] = useState<IntentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  useEffect(() => {
    api
      .getMission(missionId)
      .then(setMission)
      .catch(err =>
        setError(apiErrorMessage(err, "Impossible de charger la mission.")),
      );
  }, [missionId]);

  async function handleCreateIntent() {
    setPending(true);
    setError(null);
    setErrorCode(null);
    try {
      setIntent(await api.createIntent(missionId));
    } catch (err) {
      if (err instanceof api.ApiError) {
        setErrorCode(err.code);
      }
      setError(
        apiErrorMessage(err, "Échec de la création du paiement — erreur réseau."),
      );
    } finally {
      setPending(false);
    }
  }

  if (error && !mission)
    return <p className="text-sm text-destructive">{error}</p>;
  if (!mission)
    return <p className="text-sm text-muted-foreground">Chargement…</p>;

  const totalCents = mission.budgetCents + mission.commissionCents;

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Récapitulatif financier</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="font-medium">{mission.targetProduct}</p>
          <p className="text-muted-foreground">{mission.destination}</p>
          <dl className="mt-3 space-y-1">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Budget produit</dt>
              <dd>{centsToEur(mission.budgetCents)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Commission voyageur</dt>
              <dd>{centsToEur(mission.commissionCents)}</dd>
            </div>
            <div className="flex justify-between border-t pt-1 font-medium">
              <dt>Total séquestré</dt>
              <dd>{centsToEur(totalCents)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Paiement</CardTitle>
        </CardHeader>
        <CardContent>
          {!publishableKey || !stripePromise ? (
            <p className="text-sm text-destructive">
              NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY manquante — configurez
              frontend/.env.local.
            </p>
          ) : intent?.clientSecret ? (
            <Elements
              stripe={stripePromise}
              options={{ clientSecret: intent.clientSecret }}
            >
              <CheckoutForm amountCents={intent.amountCents} />
            </Elements>
          ) : (
            <div className="space-y-3">
              <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                Waylo agit exclusivement comme tiers de confiance. Le transport
                et l&apos;importation sont gérés de pair à pair entre
                l&apos;Acheteur et le Voyageur.
              </p>
              <label
                htmlFor="acceptTerms"
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <input
                  id="acceptTerms"
                  type="checkbox"
                  className="mt-0.5"
                  checked={acceptedTerms}
                  onChange={e => setAcceptedTerms(e.target.checked)}
                />
                <span>
                  J&apos;accepte les{" "}
                  <a
                    href="/cgu"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                  >
                    CGU
                  </a>{" "}
                  et le fonctionnement de la mise en relation sous séquestre.
                </span>
              </label>
              {error && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
                  <p className="text-sm text-destructive">{error}</p>
                  {errorCode === "INSUFFICIENT_FUNDS_FOR_MISSION" && (
                    <Button
                      className="mt-3 w-full"
                      variant="outline"
                      render={<Link href="/wallet/recharge" />}
                    >
                      Recharger le Wallet
                    </Button>
                  )}
                </div>
              )}
              <Button
                className="w-full"
                disabled={
                  pending || mission.status !== "CREATED" || !acceptedTerms
                }
                onClick={handleCreateIntent}
              >
                {pending ? "Préparation…" : "Procéder au paiement"}
              </Button>
              {mission.status !== "CREATED" && (
                <p className="text-sm text-muted-foreground">
                  Statut actuel : {mission.status} — financement impossible.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function PayPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <RequireAuth>
      <PayContent missionId={id} />
    </RequireAuth>
  );
}
