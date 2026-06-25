// Persistance chiffrée du cache de missions via expo-secure-store.
//
// Même pattern que auth/secure-store.ts : données au repos chiffrées par le
// Keychain (iOS) / Keystore (Android). Les missions ne sont PAS des données
// d'authentification, mais leur confidentialité (produit, budget, destination)
// justifie le stockage sécurisé plutôt qu'AsyncStorage (clair sur disque).
//
// Taille : pour Waylo (marketplace P2P), un utilisateur a typiquement < 30
// missions actives — environ 10-15 KB de JSON, dans les limites de SecureStore.

import * as SecureStore from 'expo-secure-store';
import type { MissionCacheEntry } from './mission.store.types';

const CACHE_KEY = 'waylo.missions.cache.v1';

export async function readMissionsCache(): Promise<MissionCacheEntry | null> {
  const raw = await SecureStore.getItemAsync(CACHE_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as MissionCacheEntry;
  } catch {
    // Corruption ou format obsolète : on purge silencieusement.
    await SecureStore.deleteItemAsync(CACHE_KEY);
    return null;
  }
}

export async function writeMissionsCache(entry: MissionCacheEntry): Promise<void> {
  await SecureStore.setItemAsync(CACHE_KEY, JSON.stringify(entry));
}

export async function clearMissionsCache(): Promise<void> {
  await SecureStore.deleteItemAsync(CACHE_KEY);
}
