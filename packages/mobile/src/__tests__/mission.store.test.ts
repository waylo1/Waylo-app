// Suite MissionStore — optimistic updates, rollback hybride O(1), 409, persistance.
//
// Le store est un singleton Zustand : on `reset()` + clearAllMocks avant chaque test.
// SecureStore est mocké globalement (jest.setup.ts) ; on surcharge par test au besoin.

import * as SecureStore from 'expo-secure-store';
import type { MissionDTO } from '@waylo/shared';
import { useMissionStore, MissionStoreError } from '../missions/mission.store';
import { MAX_PERSISTED_MISSIONS } from '../missions/mission-cache';
import { withOptimisticUpdate } from '../missions/optimistic';
import { ApiError } from '../api/errors';
import type { MissionId, MutationId, PersistedMissionCache } from '../missions/mission.store.types';

const getItem = SecureStore.getItemAsync as jest.Mock;
const setItem = SecureStore.setItemAsync as jest.Mock;
const deleteItem = SecureStore.deleteItemAsync as jest.Mock;

// -- Fixtures ----------------------------------------------------------------

function makeMission(overrides: Partial<MissionDTO> = {}): MissionDTO {
  return {
    id: 'm1',
    buyerId: 'buyer1',
    travelerId: null,
    status: 'AWAITING_VALIDATION',
    targetProduct: 'Sac à main',
    budgetCents: 10_000,
    commissionCents: 1_500,
    origin: 'Paris',
    destination: 'Tokyo',
    substitutionAuthorized: false,
    deliveryProofStatus: 'PENDING',
    version: 0,
    expiresAt: '2026-07-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

const NOW = 1_000;
const now = (): number => NOW;
const mid = (id: string): MissionId => id as MissionId;

beforeEach(() => {
  jest.clearAllMocks();
  useMissionStore.getState().reset();
});

// ============================================================================
// syncMissions
// ============================================================================

describe('syncMissions', () => {
  it('ingère des DTOs confirmés → source network, lastSyncedAt, version conservée', () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 3 })], NOW);

    const entity = useMissionStore.getState().missions['m1'];
    expect(entity.data.version).toBe(3);
    expect(entity._meta).toEqual({ lastSyncedAt: NOW, source: 'network', stale: false });
    expect(useMissionStore.getState()._meta.source).toBe('network');
  });

  it('fusionne sans écraser les missions déjà présentes', () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1' })], NOW);
    useMissionStore.getState().syncMissions([makeMission({ id: 'm2' })], NOW + 1);

    expect(Object.keys(useMissionStore.getState().missions).sort()).toEqual(['m1', 'm2']);
  });
});

// ============================================================================
// beginMutation
// ============================================================================

describe('beginMutation', () => {
  beforeEach(() => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 2 })], NOW);
  });

  it('applique l’optimisme (VALIDATED) et capture la pré-image dans le snapshot', () => {
    const id = useMissionStore.getState().beginMutation(mid('m1'), 'VALIDATE', NOW);

    const state = useMissionStore.getState();
    // Entité optimiste : statut anticipé, version INCHANGÉE (assignée au commit).
    expect(state.missions['m1'].data.status).toBe('VALIDATED');
    expect(state.missions['m1'].data.version).toBe(2);

    // Snapshot = pré-image confirmée (statut d’origine, baseVersion).
    const pending = state._pendingMutations[id];
    expect(pending.status).toBe('inflight');
    expect(pending.expectedVersion).toBe(2);
    expect(pending.snapshot.baseVersion).toBe(2);
    expect(pending.snapshot.entity.data.status).toBe('AWAITING_VALIDATION');
  });

  it('rejette une mission inconnue (MISSION_UNKNOWN)', () => {
    expect(() => useMissionStore.getState().beginMutation(mid('ghost'), 'VALIDATE', NOW)).toThrow(
      MissionStoreError,
    );
  });

  it('rejette une 2ᵉ mutation en vol sur la même mission (MUTATION_IN_FLIGHT)', () => {
    useMissionStore.getState().beginMutation(mid('m1'), 'VALIDATE', NOW);
    expect(() => useMissionStore.getState().beginMutation(mid('m1'), 'CONFIRM_RECEIPT', NOW)).toThrow(
      /MUTATION_IN_FLIGHT/,
    );
  });
});

// ============================================================================
// commit / rollback / fail (réducteurs directs)
// ============================================================================

describe('commitMutation', () => {
  it('remplace par la réponse serveur (nouvelle version) et retire la mutation', () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 2 })], NOW);
    const id = useMissionStore.getState().beginMutation(mid('m1'), 'VALIDATE', NOW);

    const serverResult = makeMission({ id: 'm1', status: 'VALIDATED', version: 3 });
    useMissionStore.getState().commitMutation(id, serverResult, NOW + 5);

    const state = useMissionStore.getState();
    expect(state.missions['m1'].data.version).toBe(3);
    expect(state.missions['m1']._meta).toEqual({ lastSyncedAt: NOW + 5, source: 'network', stale: false });
    expect(state._pendingMutations[id]).toBeUndefined();
  });

  it('lève MUTATION_UNKNOWN pour un id inconnu', () => {
    expect(() =>
      useMissionStore.getState().commitMutation('mut_x' as MutationId, makeMission(), NOW),
    ).toThrow(/MUTATION_UNKNOWN/);
  });
});

describe('rollbackOnConflict (409)', () => {
  it('restaure la pré-image, marque stale, retire la mutation', () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 2 })], NOW);
    const id = useMissionStore.getState().beginMutation(mid('m1'), 'VALIDATE', NOW);

    useMissionStore.getState().rollbackOnConflict(id, {
      error: 'VERSION_CONFLICT',
      details: { currentVersion: 5, expectedVersion: 2 },
    });

    const state = useMissionStore.getState();
    expect(state.missions['m1'].data.status).toBe('AWAITING_VALIDATION'); // pré-image restaurée
    expect(state.missions['m1'].data.version).toBe(2); // version NON fabriquée
    expect(state.missions['m1']._meta.stale).toBe(true);
    expect(state._pendingMutations[id]).toBeUndefined();
  });
});

describe('failMutation (réseau/5xx)', () => {
  it('défait l’optimisme (pré-image) et marque stale', () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 2 })], NOW);
    const id = useMissionStore.getState().beginMutation(mid('m1'), 'VALIDATE', NOW);

    useMissionStore.getState().failMutation(id);

    const state = useMissionStore.getState();
    expect(state.missions['m1'].data.status).toBe('AWAITING_VALIDATION');
    expect(state.missions['m1']._meta.stale).toBe(true);
    expect(state._pendingMutations[id]).toBeUndefined();
  });
});

// ============================================================================
// withOptimisticUpdate — réconciliation
// ============================================================================

describe('withOptimisticUpdate', () => {
  beforeEach(() => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 2 })], NOW);
  });

  it('200 → committed : envoie expectedVersion, commit la réponse, persiste', async () => {
    const server = makeMission({ id: 'm1', status: 'VALIDATED', version: 3 });
    const request = jest.fn().mockResolvedValue(server);

    const outcome = await withOptimisticUpdate(useMissionStore, {
      missionId: mid('m1'),
      kind: 'VALIDATE',
      request,
      now,
    });

    expect(request).toHaveBeenCalledWith(2); // expectedVersion figé
    expect(outcome).toEqual({ status: 'committed', mission: server });
    expect(useMissionStore.getState().missions['m1'].data.version).toBe(3);
    expect(useMissionStore.getState()._pendingMutations).toEqual({});
    expect(setItem).toHaveBeenCalledTimes(1); // persistance déclenchée
  });

  it('409 → conflict : rollback + stale + ConflictPayload retourné', async () => {
    const request = jest
      .fn()
      .mockRejectedValue(new ApiError('VERSION_CONFLICT', 409, { currentVersion: 7, expectedVersion: 2 }));

    const outcome = await withOptimisticUpdate(useMissionStore, {
      missionId: mid('m1'),
      kind: 'VALIDATE',
      request,
      now,
    });

    expect(outcome).toEqual({
      status: 'conflict',
      conflict: { error: 'VERSION_CONFLICT', details: { currentVersion: 7, expectedVersion: 2 } },
    });
    const entity = useMissionStore.getState().missions['m1'];
    expect(entity.data.status).toBe('AWAITING_VALIDATION');
    expect(entity._meta.stale).toBe(true);
    expect(useMissionStore.getState()._pendingMutations).toEqual({});
  });

  it('réseau → failed : rollback, ApiError retournée', async () => {
    const request = jest.fn().mockRejectedValue(new ApiError('NETWORK_ERROR', 0));

    const outcome = await withOptimisticUpdate(useMissionStore, {
      missionId: mid('m1'),
      kind: 'VALIDATE',
      request,
      now,
    });

    expect(outcome.status).toBe('failed');
    expect(useMissionStore.getState().missions['m1'].data.status).toBe('AWAITING_VALIDATION');
    expect(useMissionStore.getState()._pendingMutations).toEqual({});
  });

  it('mission inconnue → rejected MISSION_UNKNOWN (aucun appel réseau)', async () => {
    const request = jest.fn();
    const outcome = await withOptimisticUpdate(useMissionStore, {
      missionId: mid('ghost'),
      kind: 'VALIDATE',
      request,
      now,
    });

    expect(outcome).toEqual({ status: 'rejected', reason: 'MISSION_UNKNOWN' });
    expect(request).not.toHaveBeenCalled();
  });

  it('mutation déjà en vol → rejected MUTATION_IN_FLIGHT', async () => {
    useMissionStore.getState().beginMutation(mid('m1'), 'VALIDATE', NOW); // occupe la mission
    const request = jest.fn();

    const outcome = await withOptimisticUpdate(useMissionStore, {
      missionId: mid('m1'),
      kind: 'CONFIRM_RECEIPT',
      request,
      now,
    });

    expect(outcome).toEqual({ status: 'rejected', reason: 'MUTATION_IN_FLIGHT' });
    expect(request).not.toHaveBeenCalled();
  });

  it('rollback O(1) : seules l’entité ciblée change, les autres gardent leur référence', async () => {
    const many: MissionDTO[] = Array.from({ length: 100 }, (_, i) =>
      makeMission({ id: `k${i}`, version: 2, updatedAt: `2026-06-${(i % 28) + 1}T00:00:00.000Z` }),
    );
    useMissionStore.getState().syncMissions(many, NOW);
    const before = useMissionStore.getState().missions;

    await withOptimisticUpdate(useMissionStore, {
      missionId: mid('k50'),
      kind: 'VALIDATE',
      request: jest.fn().mockRejectedValue(new ApiError('VERSION_CONFLICT', 409, { currentVersion: 9, expectedVersion: 2 })),
      now,
    });

    const after = useMissionStore.getState().missions;
    // Toutes les autres entités sont la MÊME référence (jamais reconstruites) → O(1).
    expect(after['k49']).toBe(before['k49']);
    expect(after['k51']).toBe(before['k51']);
    expect(after['k0']).toBe(before['k0']);
    // Seule k50 a changé (stale après conflit).
    expect(after['k50']).not.toBe(before['k50']);
    expect(after['k50']._meta.stale).toBe(true);
  });
});

// ============================================================================
// Persistance (SecureStore)
// ============================================================================

describe('persist', () => {
  it('persiste l’état confirmé (clé waylo.missions.v1, schemaVersion 1)', async () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 2 })], NOW);
    await useMissionStore.getState().persist();

    expect(setItem).toHaveBeenCalledTimes(1);
    const [key, raw] = setItem.mock.calls[0] as [string, string];
    expect(key).toBe('waylo.missions.v1');
    const cache = JSON.parse(raw) as PersistedMissionCache;
    expect(cache.schemaVersion).toBe(1);
    expect(cache.missions).toHaveLength(1);
    expect(cache.missions[0].data.id).toBe('m1');
  });

  it('persiste la PRÉ-IMAGE (pas l’optimisme) pour une mutation en vol', async () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm1', version: 2 })], NOW);
    useMissionStore.getState().beginMutation(mid('m1'), 'VALIDATE', NOW); // optimiste VALIDATED en mémoire

    await useMissionStore.getState().persist();

    const cache = JSON.parse((setItem.mock.calls[0] as [string, string])[1]) as PersistedMissionCache;
    // L’état persisté reste la dernière donnée CONFIRMÉE, pas l’optimisme.
    expect(cache.missions[0].data.status).toBe('AWAITING_VALIDATION');
  });

  it('borne le cache à MAX_PERSISTED_MISSIONS, trié par updatedAt décroissant', async () => {
    const many: MissionDTO[] = Array.from({ length: MAX_PERSISTED_MISSIONS + 10 }, (_, i) =>
      makeMission({ id: `k${i}`, updatedAt: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    useMissionStore.getState().syncMissions(many, NOW);
    await useMissionStore.getState().persist();

    const cache = JSON.parse((setItem.mock.calls[0] as [string, string])[1]) as PersistedMissionCache;
    expect(cache.missions).toHaveLength(MAX_PERSISTED_MISSIONS);
    // Trié décroissant : le premier a un updatedAt >= au deuxième.
    expect(cache.missions[0].data.updatedAt >= cache.missions[1].data.updatedAt).toBe(true);
  });
});

describe('hydrate', () => {
  it('charge le cache → missions en mémoire avec source cache', async () => {
    const cache: PersistedMissionCache = {
      missions: [
        {
          data: makeMission({ id: 'm1', version: 4 }),
          _meta: { lastSyncedAt: 500, source: 'network', stale: false },
        },
      ],
      _meta: { lastSyncedAt: 500, source: 'network', stale: false },
      schemaVersion: 1,
    };
    getItem.mockResolvedValueOnce(JSON.stringify(cache));

    await useMissionStore.getState().hydrate();

    const entity = useMissionStore.getState().missions['m1'];
    expect(entity.data.version).toBe(4);
    expect(entity._meta.source).toBe('cache'); // provenance recalculée au chargement
    expect(entity._meta.lastSyncedAt).toBe(500); // fraîcheur d’origine préservée
  });

  it('cache absent → no-op (store vide)', async () => {
    getItem.mockResolvedValueOnce(null);
    await useMissionStore.getState().hydrate();
    expect(useMissionStore.getState().missions).toEqual({});
  });

  it('cache corrompu → poison-pill (purge) et store vide', async () => {
    getItem.mockResolvedValueOnce('{ this is not json');
    await useMissionStore.getState().hydrate();

    expect(useMissionStore.getState().missions).toEqual({});
    expect(deleteItem).toHaveBeenCalledWith('waylo.missions.v1');
  });

  it('schéma obsolète → purge et store vide', async () => {
    getItem.mockResolvedValueOnce(JSON.stringify({ missions: [], _meta: {}, schemaVersion: 99 }));
    await useMissionStore.getState().hydrate();

    expect(useMissionStore.getState().missions).toEqual({});
    expect(deleteItem).toHaveBeenCalledWith('waylo.missions.v1');
  });
});
