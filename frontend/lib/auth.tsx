"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import * as api from "./api";
import type { AuthUser } from "./types";

// Session JWT côté client : jeton en localStorage, profil relu via /auth/me.
// `status` évite le flash de redirection pendant l'hydratation.

type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const router = useRouter();

  // Fetch pur (aucun setState) : l'application d'état se fait dans une
  // continuation asynchrone — jamais de setState synchrone dans un effet.
  const fetchAuthState = useCallback(async (): Promise<{
    status: AuthStatus;
    user: AuthUser | null;
  }> => {
    if (!api.getToken()) return { status: "anonymous", user: null };
    try {
      const profile = await api.me();
      return { status: "authenticated", user: profile };
    } catch {
      // Jeton expiré/invalide : purge et retour anonyme.
      api.clearToken();
      return { status: "anonymous", user: null };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthState().then(next => {
      if (cancelled) return;
      setUser(next.user);
      setStatus(next.status);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAuthState]);

  const signIn = useCallback(
    async (token: string) => {
      api.setToken(token);
      const next = await fetchAuthState();
      setUser(next.user);
      setStatus(next.status);
    },
    [fetchAuthState],
  );

  const signOut = useCallback(() => {
    api.clearToken();
    setUser(null);
    setStatus("anonymous");
    router.push("/login");
  }, [router]);

  const value = useMemo(
    () => ({ status, user, signIn, signOut }),
    [status, user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit être utilisé sous <AuthProvider>");
  return ctx;
}
