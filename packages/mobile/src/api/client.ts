// Client HTTP Axios pour l'API Waylo — instance UNIQUE, partagée par toute l'app.
//
// Sécurité — invariants à ne JAMAIS régresser :
// - Le token n'est pas en variable de module : il est lu à chaque requête depuis
//   le store d'auth (`useAuthStore.getState().session?.token`). Aucun déphasage
//   possible après `setSession`/`clearSession`.
// - Le header `Authorization` n'est jamais loggé (ni par nous, ni par les
//   intercepteurs — Axios par défaut ne log pas, mais on ne le réveille pas).
// - Les écrans reçoivent une `ApiError` typée (cf. ./errors.ts) qui ne contient
//   ni token, ni URL d'origine, ni stack Axios — `console.log(err)` est sûr.
// - 401 → purge automatique de la session (le `RootNavigator` route alors vers
//   Login via le gating existant — aucun appel `navigation.navigate()` requis).
//
// Configuration baseURL :
// - `EXPO_PUBLIC_API_URL` si défini (production, devices physiques en dev).
// - Sinon Android emulator (`Platform.OS === 'android'`) → `http://10.0.2.2:3000`
//   (convention Google : 10.0.2.2 = loopback de la machine hôte depuis l'emu).
// - Sinon (iOS Simulator, web) → `http://localhost:3000`.
// Ce fallback ne couvre pas les devices physiques : pour un téléphone branché
// sur le réseau LAN, exporter `EXPO_PUBLIC_API_URL=http://<IP_LAN>:3000` avant
// `expo start`. Pas de STOP en l'absence (consigne MOB-04).

import {
  create as createAxiosInstance,
  isAxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import { Platform } from 'react-native';
import { useAuthStore } from '../auth/auth.store';
import { ApiError, normalizeAxiosError } from './errors';

function resolveBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:3000';
  }
  return 'http://localhost:3000';
}

export const apiClient: AxiosInstance = createAxiosInstance({
  baseURL: resolveBaseUrl(),
  timeout: 15_000,
  headers: { Accept: 'application/json' },
});

// REQUEST — injecte le Bearer depuis le store SANS logger le token.
apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = useAuthStore.getState().session?.token;
  if (typeof token === 'string' && token.length > 0) {
    // `config.headers` est une `AxiosHeaders` (jamais undefined sur InternalAxiosRequestConfig).
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

// RESPONSE — 401 ⇒ purge session (déclenche le swap stack via RootNavigator) ;
// 5xx/réseau ⇒ `ApiError` typée, jamais le token dans le rejet.
apiClient.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    const apiError = isAxiosError(error)
      ? normalizeAxiosError(error)
      : new ApiError('UNKNOWN_ERROR', 0);

    if (apiError.status === 401) {
      // Fire-and-forget : on n'attend PAS la purge SecureStore pour rejeter
      // l'appelant (qui doit recevoir l'erreur sans délai). La purge se résout
      // en parallèle ; le composant écoutant le store re-render au moment où
      // `status` bascule sur 'unauthenticated'.
      void useAuthStore.getState().clearSession();
    }
    return Promise.reject(apiError);
  },
);
