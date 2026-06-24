// Store Zustand pour l'état d'authentification mobile.
//
// Deux couches, par contrat :
// 1. `SecureStore` (./secure-store.ts) — persistance chiffrée du token (Keychain/Keystore).
// 2. Zustand (ce fichier) — état d'auth en MÉMOIRE, hydraté au boot depuis (1)
//    PUIS confronté au backend (`GET /api/auth/me`). Validation OPTIMISTE
//    (MOB-06) : seul un rejet ACTIF du serveur (401) déconnecte ; une absence
//    de réponse (réseau / 5xx) GARDE la session persistée. Sécurité intacte :
//    si le token est en fait mort, le prochain appel authentifié recevra un 401
//    et l'intercepteur (client.ts) fera `clearSession`.
//
// `status` distingue trois moments :
// - 'loading'         : `hydrate()` n'est pas encore résolu (boot du Splash).
// - 'authenticated'   : session en mémoire (validée par /me, OU conservée par
//                       optimisme quand le serveur n'a pas répondu).
// - 'unauthenticated' : hydrate résolu, aucune session (ou token rejeté en 401).
//
// Le Splash (App.tsx) bloque le rendu tant que `status === 'loading'` puis route
// une seule fois — élimine race et flash entre Login et Dashboard.
//
// Règle d'or : JAMAIS de log du token (`session.token`). Les messages d'erreur
// ne doivent rien contenir de secret.

import { create } from 'zustand';
import type { SessionDTO } from '@waylo/shared';
import { getMe } from '../api/auth.api';
import { toApiError } from '../api/errors';
import { clearStoredSession, readSession, writeSession } from './secure-store';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthState {
  status: AuthStatus;
  session: SessionDTO | null;
  /** Hydrate l'état depuis SecureStore + valide le token contre le backend. Single-flight. */
  hydrate: () => Promise<void>;
  /** Retourne la session courante (null si non authentifié). Vue mémoire — ne touche pas SecureStore. */
  getSession: () => SessionDTO | null;
  /** Persiste la session dans SecureStore PUIS met à jour l'état mémoire. */
  setSession: (session: SessionDTO) => Promise<void>;
  /** Purge SecureStore + mémoire (logout). */
  clearSession: () => Promise<void>;
}

// Single-flight : si `hydrate` est appelé deux fois en parallèle (StrictMode, Splash
// monté deux fois en dev), on attend la même promesse plutôt que d'enchaîner deux
// lectures SecureStore — pas de race possible sur l'état initial.
let hydrationPromise: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  session: null,

  hydrate: () => {
    if (hydrationPromise !== null) {
      return hydrationPromise;
    }
    hydrationPromise = (async () => {
      const stored = await readSession();
      if (stored === null) {
        set({ status: 'unauthenticated', session: null });
        return;
      }
      // Token présent : on le confronte au backend, validation OPTIMISTE (MOB-06).
      try {
        const freshUser = await getMe(stored.token);
        const refreshed: SessionDTO = { ...stored, user: freshUser };
        await writeSession(refreshed);
        set({ status: 'authenticated', session: refreshed });
      } catch (err) {
        if (toApiError(err).status === 401) {
          // Rejet ACTIF du serveur : token expiré / révoqué → logout strict.
          // (L'intercepteur 401 a déjà appelé clearSession ; ce second appel est
          // idempotent — SecureStore.deleteItemAsync ne re-erreur pas.)
          await clearStoredSession();
          set({ status: 'unauthenticated', session: null });
          return;
        }
        // Réseau / 5xx : le serveur n'a PAS statué sur la validité du token. On
        // ne PUNIT pas l'utilisateur d'une coupure (redémarrage backend, 4G qui
        // hoquette, cold start) — on GARDE la session persistée telle quelle. Si
        // le token est en fait mort, le prochain appel authentifié 401-era et
        // l'intercepteur fera clearSession (sécurité inchangée).
        set({ status: 'authenticated', session: stored });
      }
    })();
    return hydrationPromise;
  },

  getSession: () => get().session,

  setSession: async (session) => {
    await writeSession(session);
    set({ status: 'authenticated', session });
  },

  clearSession: async () => {
    await clearStoredSession();
    set({ status: 'unauthenticated', session: null });
  },
}));
