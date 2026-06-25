// Store Mission (Zustand) — optimistic updates + lecture offline.
//
// Implémente la forme + le contrat fixés par ARCH-STORE-00
// (mission.store.types.ts) et docs/adr/0001-mission-store-architecture.md.
//
// Couches (comme auth.store) :
// 1. SecureStore (mission-cache.ts) — persistance chiffrée du cache CONFIRMÉ.
// 2. Zustand (ce fichier) — état mémoire ; rollback hybride O(1) via les snapshots
//    embarqués dans `_pendingMutations`.
//
// Pattern d'état ATOMIQUE : chaque action est un `set()` unique qui met à jour
// `missions`, `_pendingMutations` et `_meta` ensemble — jamais d'intermédiaire visible.
//
// Le temps est INJECTÉ (`at: number`) — jamais `Date.now()` interne (déterminisme).

import { create } from 'zustand';
import type { MissionDTO, MissionStatus } from '@waylo/shared';
import type {
  MissionEntity,
  MissionSlice,
  MutationId,
  PendingMutation,
  PendingMutationKind,
} from './mission.store.types';
import {
  INITIAL_META,
  readMissionCache,
  toPersistedCache,
  writeMissionCache,
} from './mission-cache';

/**
 * Erreur de précondition du store (mission inconnue, mutation déjà en vol). Levée
 * par les actions de mutation ; l'orchestrateur `withOptimisticUpdate` la traduit
 * en issue propre plutôt que de la laisser fuiter.
 */
export class MissionStoreError extends Error {
  constructor(readonly code: 'MISSION_UNKNOWN' | 'MUTATION_IN_FLIGHT' | 'MUTATION_UNKNOWN') {
    super(code);
    this.name = 'MissionStoreError';
  }
}

// Compteur monotone pour des MutationId uniques au sein d'une session (pas de
// Math.random : id non deviné par valeur dans les tests, corrélé par le retour).
let mutationCounter = 0;
function nextMutationId(at: number): MutationId {
  mutationCounter += 1;
  return `mut_${at}_${mutationCounter}` as MutationId;
}

/**
 * Effet optimiste local d'une mutation acheteur. VALIDATE et CONFIRM_RECEIPT
 * mènent toutes deux la mission à `VALIDATED` côté serveur ; on l'anticipe. La
 * `version` reste à la base (le serveur assigne la nouvelle au commit).
 */
function applyOptimisticPatch(data: MissionDTO, kind: PendingMutationKind): MissionDTO {
  switch (kind) {
    case 'VALIDATE':
    case 'CONFIRM_RECEIPT':
      return { ...data, status: 'VALIDATED' satisfies MissionStatus };
  }
}

/** Première mutation `inflight` trouvée pour une mission (invariant ≤ 1). */
function inflightFor(
  pendings: Readonly<Record<MutationId, PendingMutation>>,
  missionId: string,
): PendingMutation | undefined {
  return Object.values(pendings).find(
    p => p.missionId === missionId && p.status === 'inflight',
  );
}

/** Retire une entrée d'un Record sans muter l'original (remplacement immuable). */
function omit<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  const next: Record<string, V> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== key) {
      next[k] = v;
    }
  }
  return next;
}

export const useMissionStore = create<MissionSlice>((set, get) => ({
  missions: {},
  _pendingMutations: {},
  _meta: INITIAL_META,

  syncMissions: (missions, at) => {
    set(state => {
      const next = { ...state.missions };
      for (const data of missions) {
        next[data.id] = {
          data,
          _meta: { lastSyncedAt: at, source: 'network', stale: false },
        };
      }
      return {
        missions: next,
        _meta: { lastSyncedAt: at, source: 'network', stale: false },
      };
    });
  },

  beginMutation: (missionId, kind, at) => {
    const state = get();
    const entity = state.missions[missionId];
    if (entity === undefined) {
      throw new MissionStoreError('MISSION_UNKNOWN');
    }
    if (inflightFor(state._pendingMutations, missionId) !== undefined) {
      throw new MissionStoreError('MUTATION_IN_FLIGHT');
    }

    const id = nextMutationId(at);
    const baseVersion = entity.data.version;
    const pending: PendingMutation = {
      id,
      kind,
      missionId,
      expectedVersion: baseVersion,
      snapshot: { entity, baseVersion, capturedAt: at },
      status: 'inflight',
      createdAt: at,
    };
    const optimistic: MissionEntity = {
      data: applyOptimisticPatch(entity.data, kind),
      _meta: entity._meta,
    };

    set(s => ({
      missions: { ...s.missions, [missionId]: optimistic },
      _pendingMutations: { ...s._pendingMutations, [id]: pending },
    }));
    return id;
  },

  commitMutation: (id, result, at) => {
    const pending = get()._pendingMutations[id];
    if (pending === undefined) {
      throw new MissionStoreError('MUTATION_UNKNOWN');
    }
    const confirmed: MissionEntity = {
      data: result,
      _meta: { lastSyncedAt: at, source: 'network', stale: false },
    };
    set(s => ({
      missions: { ...s.missions, [pending.missionId]: confirmed },
      _pendingMutations: omit(s._pendingMutations, id),
    }));
  },

  rollbackOnConflict: (id, conflict) => {
    const pending = get()._pendingMutations[id];
    if (pending === undefined) {
      throw new MissionStoreError('MUTATION_UNKNOWN');
    }
    // Rollback O(1) : restauration de la pré-image embarquée (aucune relecture, aucun
    // rejeu). Le 409 prouve que le serveur a avancé (currentVersion > expectedVersion)
    // → on marque `stale` pour forcer un refetch. On ne FABRIQUE PAS la version absente :
    // la donnée restaurée reste à sa baseVersion (un retry naïf re-déclencherait un 409,
    // côté sûr, jusqu'au refetch qui ramènera la donnée à currentVersion).
    const serverAhead = conflict.details.currentVersion > pending.snapshot.baseVersion;
    const restored: MissionEntity = {
      data: pending.snapshot.entity.data,
      _meta: { ...pending.snapshot.entity._meta, stale: serverAhead },
    };
    set(s => ({
      missions: { ...s.missions, [pending.missionId]: restored },
      _pendingMutations: omit(s._pendingMutations, id),
    }));
  },

  failMutation: id => {
    const pending = get()._pendingMutations[id];
    if (pending === undefined) {
      throw new MissionStoreError('MUTATION_UNKNOWN');
    }
    // Écriture non confirmée (réseau/5xx) : on défait l'optimisme. État serveur
    // incertain → `stale` pour vérification au prochain refetch.
    const restored: MissionEntity = {
      data: pending.snapshot.entity.data,
      _meta: { ...pending.snapshot.entity._meta, stale: true },
    };
    set(s => ({
      missions: { ...s.missions, [pending.missionId]: restored },
      _pendingMutations: omit(s._pendingMutations, id),
    }));
  },

  hydrate: async () => {
    const cache = await readMissionCache();
    if (cache === null) {
      return;
    }
    const missions: Record<string, MissionEntity> = {};
    for (const entity of cache.missions) {
      // Servi depuis le disque : provenance = 'cache' (la fraîcheur lastSyncedAt
      // reste celle du dernier ACK réseau au moment de la persistance).
      missions[entity.data.id] = {
        data: entity.data,
        _meta: { ...entity._meta, source: 'cache' },
      };
    }
    set({ missions, _meta: { ...cache._meta, source: 'cache' } });
  },

  persist: async () => {
    await writeMissionCache(toPersistedCache(get()));
  },

  reset: () => {
    set({ missions: {}, _pendingMutations: {}, _meta: INITIAL_META });
  },
}));
