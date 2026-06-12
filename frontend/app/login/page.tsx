"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { signIn } = useAuth();
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const { token } =
        mode === "login"
          ? await api.login(email, password)
          : await api.register(email, password);
      await signIn(token);
      router.push("/missions");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm pt-12">
      <Card>
        <CardHeader>
          <CardTitle>
            {mode === "login" ? "Connexion" : "Créer un compte"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Mot de passe</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={mode === "register" ? 8 : undefined}
                value={password}
                onChange={e => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending
                ? "…"
                : mode === "login"
                  ? "Se connecter"
                  : "Créer le compte"}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 text-sm text-muted-foreground underline-offset-4 hover:underline"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login"
              ? "Pas de compte ? S'inscrire"
              : "Déjà un compte ? Se connecter"}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
