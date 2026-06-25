// Persistance du cache Mission via SecureStore (lecture offline).
//
// Même couche et mêmes garanties que `auth/secure-store.ts` : chiffré au repos
// (Keychain iOS / Keystore Android), JSON sérialisé, AsyncStorage interdit.
//
// On NE persiste que l'état CONFIRMÉ (cf. ADR 0001, Décision 4) : pour une mission
// qui porte une mutation optimiste en vol, on persiste sa PRÉ-IMAGE (le snapshot),
// jamais l'état optimiste non confirmé. Les `_pendingMutations` ne sont jamais
// persistées (volatiles par conception).
//
// Borne de taille : SecureStore plafonne ~2 KB/item sur iOS. On cape donc le cache
// aux MAX_PERSISTED_MISSIONS missions les plus récemment mises à jour.

import * as SecureStore from 'expo-secure-store';
import type {
  EntityMeta,
  MissionEntity,
  MissionSliceState,
  PersistedMissionCache,
} from './mission.store.types';

const MISSIONS_KEY = 'waylo.missions.v1';

/** Plafond de missions persistées (borne ~2 KB SecureStore iOS). */
export const MAX_PERSISTED_MISSIONS = 50;

/** Schéma courant du cache persisté (bump → invalidation au boot). */
const CACHE_SCHEMA_VERSION = 1 as const;

/**
 * Projette l'état du slice vers la forme persistable : état CONFIRMÉ uniquement,
 * borné et trié (missions les plus récemment mises à jour d'abord).
 *
 * Pour une mission avec mutation en vol, on substitue la pré-image du snapshot —
 * la dernière donnée confirmée — afin de ne jamais persister d'optimisme.
 */
export function toPersistedCache(state: MissionSliceState): PersistedMissionCache {
  // Index missionId → pré-image confirmée (snapshot) des mutations en vol.
  const preimageByMission = new Map<string, MissionEntity>();
  for (const pending of Object.values(state._pendingMutations)) {
    if (pending.status === 'inflight') {
      preimageByMission.set(pending.missionId, pending.snapshot.entity);
    }
  }

  const confirmed: MissionEntity[] = Object.values(state.missions).map(
    entity => preimageByMission.get(entity.data.id) ?? entity,
  );

  // Tri par fraîcheur de la donnée (updatedAt ISO, ordre décroissant) puis cap.
  const bounded = confirmed
    .slice()
    .sort((a, b) => b.data.updatedAt.localeCompare(a.data.updatedAt))
    .slice(0, MAX_PERSISTED_MISSIONS);

  return {
    missions: bounded,
    _meta: state._meta,
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
}

/**
 * Lit le cache persisté. Retourne `null` si absent OU illisible (corruption,
 * schéma obsolète) — dans ce cas on PURGE (poison-pill), comme `readSession`.
 */
export async function readMissionCache(): Promise<PersistedMissionCache | null> {
  const raw = await SecureStore.getItemAsync(MISSIONS_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as PersistedMissionCache;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(parsed.missions)) {
      // Schéma obsolète / forme inattendue : on purge plutôt que de servir du faux.
      await SecureStore.deleteItemAsync(MISSIONS_KEY);
      return null;
    }
    return parsed;
  } catch {
    await SecureStore.deleteItemAsync(MISSIONS_KEY);
    return null;
  }
}

/** Persiste le cache (déjà projeté/borné). Sérialisation JSON. */
export async function writeMissionCache(cache: PersistedMissionCache): Promise<void> {
  await SecureStore.setItemAsync(MISSIONS_KEY, JSON.stringify(cache));
}

/** Purge le cache (logout). */
export async function clearMissionCache(): Promise<void> {
  await SecureStore.deleteItemAsync(MISSIONS_KEY);
}

/** Métadonnées de fraîcheur initiales (aucune synchro réseau encore). */
export const INITIAL_META: EntityMeta = {
  lastSyncedAt: null,
  source: 'cache',
  stale: false,
};
