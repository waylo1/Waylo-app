// Store Zustand pour les missions — offline-first.
//
// Deux couches :
// 1. `hydrate()` lit le cache SecureStore au boot → l'écran est utilisable
//    hors-ligne AVANT tout appel réseau.
// 2. `syncMissions()` est appelé après chaque fetch réussi → met à jour l'état
//    mémoire ET persiste en fire-and-forget dans SecureStore.
//
// isLoadingInitial=true jusqu'à ce que hydrate() soit résolu. Après hydrate :
// - cache présent → missions + lastSyncedAt, isLoadingInitial=false (affichage immédiat)
// - cache absent → missions=[], lastSyncedAt=null, isLoadingInitial=false

import { useEffect } from 'react';
import { create } from 'zustand';
import type { MissionStore } from './mission.store.types';
import { readMissionsCache, writeMissionsCache } from './missions-secure-store';

export const useMissionStore = create<MissionStore>((set) => ({
  missions: [],
  lastSyncedAt: null,
  isLoadingInitial: true,
  error: null,

  syncMissions: (missions, at) => {
    set({ missions, lastSyncedAt: at, error: null });
    writeMissionsCache({ missions: [...missions], lastSyncedAt: at }).catch(() => {
      // Échec silencieux : la persistence SecureStore ne doit pas affecter l'état mémoire.
    });
  },

  hydrate: async () => {
    try {
      const cached = await readMissionsCache();
      if (cached !== null) {
        set({
          missions: cached.missions,
          lastSyncedAt: cached.lastSyncedAt,
          isLoadingInitial: false,
        });
      } else {
        set({ isLoadingInitial: false });
      }
    } catch {
      // SecureStore inaccessible (rare) : on démarre sans cache, pas de crash.
      set({ isLoadingInitial: false });
    }
  },

  setLoadingInitial: (loading) => set({ isLoadingInitial: loading }),
  setError: (error) => set({ error }),
}));

/**
 * Monte la lecture SecureStore dans le cycle React (useEffect) — garantit que
 * l'I/O asynchrone n'est jamais déclenché hors du cycle de vie des composants.
 * À appeler UNE FOIS dans App.tsx (ou le root navigator) après l'auth hydration.
 */
export function useMissionHydration(): void {
  const hydrate = useMissionStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
}
