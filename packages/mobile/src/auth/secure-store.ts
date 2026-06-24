// Wrapper typé autour de expo-secure-store pour la session Waylo.
//
// expo-secure-store chiffre les valeurs au repos via le Keychain (iOS) / Keystore
// (Android). C'est la SEULE couche autorisée pour persister un token Waylo —
// AsyncStorage est interdit (clair sur disque).
//
// La forme persistée = SessionDTO complète (token + claims + user). Permet de
// router au boot sans appel réseau /me (rehydratation optimiste ; l'expiration
// sera détectée au premier appel API protégé → clearSession).
//
// Format : JSON sérialisé. SecureStore impose des chaînes (limite ~2 KB par item
// sur iOS ; un SessionDTO Waylo est très en-dessous : cuid + email + 4 champs).

import * as SecureStore from 'expo-secure-store';
import type { SessionDTO } from '@waylo/shared';

const SESSION_KEY = 'waylo.session.v1';

export async function readSession(): Promise<SessionDTO | null> {
  const raw = await SecureStore.getItemAsync(SESSION_KEY);
  if (raw === null) {
    return null;
  }
  try {
    // Pas de validation runtime ici : la clé est privée à l'app, donc on fait
    // confiance à ce qu'on a écrit. Une donnée corrompue (rare) tombera sur
    // une erreur d'API au prochain appel protégé → flow normal de clearSession.
    return JSON.parse(raw) as SessionDTO;
  } catch {
    // Donnée illisible (corruption, format obsolète) : on purge et on retourne null.
    // Pas de log du contenu — c'est du token chiffré.
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export async function writeSession(session: SessionDTO): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export async function clearStoredSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}
