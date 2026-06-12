"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

// Garde client V1 : redirige vers /login si anonyme, n'affiche rien pendant
// le chargement du jeton (pas de flash de contenu protégé).

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <p className="p-8 text-sm text-muted-foreground">Chargement…</p>
    );
  }
  return <>{children}</>;
}
