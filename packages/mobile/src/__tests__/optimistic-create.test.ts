// Suite optimistic create — addOptimisticCreate, commitCreate, abortCreate, withOptimisticCreate.
//
// Pattern identique à mission.store.test.ts : store singleton, reset avant chaque test.

import * as SecureStore from 'expo-secure-store';
import type { MissionDTO } from '@waylo/shared';
import { useMissionStore } from '../missions/mission.store';
import { withOptimisticCreate } from '../missions/optimistic';
import { ApiError } from '../api/errors';
import type { MissionId } from '../missions/mission.store.types';

const setItem = SecureStore.setItemAsync as jest.Mock;

// -- Fixtures ----------------------------------------------------------------

function makeMission(overrides: Partial<MissionDTO> = {}): MissionDTO {
  return {
    id: 'm1',
    buyerId: 'buyer1',
    travelerId: null,
    status: 'CREATED',
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

const NOW = 2_000;
const now = (): number => NOW;
const mid = (id: string): MissionId => id as MissionId;

beforeEach(() => {
  jest.clearAllMocks();
  useMissionStore.getState().reset();
});

// ============================================================================
// addOptimisticCreate
// ============================================================================

describe('addOptimisticCreate', () => {
  it('insère une mission avec un ID temporaire et source optimistic', () => {
    const mission = makeMission({ id: 'placeholder' });
    const tempId = useMissionStore.getState().addOptimisticCreate(mission, NOW);

    expect(tempId).toMatch(/^tmp_/);

    const state = useMissionStore.getState();
    expect(state.missions[tempId]).toBeDefined();
    expect(state.missions[tempId]._meta.source).toBe('optimistic');
    expect(state.missions[tempId]._meta.lastSyncedAt).toBeNull();
    expect(state.missions[tempId].data.id).toBe(tempId);
  });

  it("utilise l'ID généré (pas celui passé en paramètre)", () => {
    const mission = makeMission({ id: 'whatever' });
    const tempId = useMissionStore.getState().addOptimisticCreate(mission, NOW);

    expect(tempId).not.toBe('whatever');
    // L'ID passé en paramètre est ignoré : le store génère son propre tmp_*
    expect(useMissionStore.getState().missions['whatever']).toBeUndefined();
    expect(useMissionStore.getState().missions[tempId]).toBeDefined();
  });

  it('deux appels successifs génèrent des IDs distincts', () => {
    const id1 = useMissionStore.getState().addOptimisticCreate(makeMission(), NOW);
    const id2 = useMissionStore.getState().addOptimisticCreate(makeMission(), NOW);

    expect(id1).not.toBe(id2);
    expect(Object.keys(useMissionStore.getState().missions)).toHaveLength(2);
  });
});

// ============================================================================
// commitCreate
// ============================================================================

describe('commitCreate', () => {
  it('remplace le tmp par la mission serveur (ID réel, source network)', () => {
    const tempId = useMissionStore.getState().addOptimisticCreate(makeMission(), NOW);
    const serverMission = makeMission({ id: 'srv_m1', status: 'CREATED', version: 0 });

    useMissionStore.getState().commitCreate(tempId, serverMission, NOW + 10);

    const state = useMissionStore.getState();
    expect(state.missions[tempId]).toBeUndefined(); // tmp supprimé
    expect(state.missions['srv_m1']).toBeDefined();
    expect(state.missions['srv_m1'].data.id).toBe('srv_m1');
    expect(state.missions['srv_m1']._meta.source).toBe('network');
    expect(state.missions['srv_m1']._meta.lastSyncedAt).toBe(NOW + 10);
    expect(state.missions['srv_m1']._meta.stale).toBe(false);
  });

  it("ne touche pas aux autres missions déjà dans le store", () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'existing' })], NOW);
    const tempId = useMissionStore.getState().addOptimisticCreate(makeMission(), NOW);

    useMissionStore.getState().commitCreate(tempId, makeMission({ id: 'new_srv' }), NOW + 1);

    const state = useMissionStore.getState();
    expect(state.missions['existing']).toBeDefined();
    expect(state.missions['new_srv']).toBeDefined();
    expect(Object.keys(state.missions)).toHaveLength(2);
  });
});

// ============================================================================
// abortCreate
// ============================================================================

describe('abortCreate', () => {
  it("retire l'entrée temporaire sans laisser de trace", () => {
    const tempId = useMissionStore.getState().addOptimisticCreate(makeMission(), NOW);
    useMissionStore.getState().abortCreate(tempId);

    expect(useMissionStore.getState().missions[tempId]).toBeUndefined();
    expect(Object.keys(useMissionStore.getState().missions)).toHaveLength(0);
  });

  it("ne touche pas aux autres missions lors du rollback", () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'm_existing' })], NOW);
    const tempId = useMissionStore.getState().addOptimisticCreate(makeMission(), NOW);

    const refBefore = useMissionStore.getState().missions[mid('m_existing')];
    useMissionStore.getState().abortCreate(tempId);

    // m_existing est la MÊME référence (rollback O(1) - pas de reconstruction).
    expect(useMissionStore.getState().missions[mid('m_existing')]).toBe(refBefore);
  });
});

// ============================================================================
// toPersistedCache — les missions optimistic sont exclues
// ============================================================================

describe('persist — missions optimistic exclues', () => {
  it('ne persiste pas les missions en-vol de création (source optimistic)', async () => {
    useMissionStore.getState().syncMissions([makeMission({ id: 'confirmed' })], NOW);
    useMissionStore.getState().addOptimisticCreate(makeMission({ id: 'temp' }), NOW);

    await useMissionStore.getState().persist();

    const [, raw] = setItem.mock.calls[0] as [string, string];
    const cache = JSON.parse(raw) as { missions: { data: MissionDTO }[] };
    expect(cache.missions).toHaveLength(1);
    expect(cache.missions[0].data.id).toBe('confirmed');
  });
});

// ============================================================================
// withOptimisticCreate — orchestrateur
// ============================================================================

describe('withOptimisticCreate', () => {
  it('201 committed : insère tmp → remplace par ID serveur + persiste', async () => {
    const serverMission = makeMission({ id: 'srv_new', status: 'CREATED', version: 0 });
    const request = jest.fn().mockResolvedValue(serverMission);

    const outcome = await withOptimisticCreate(useMissionStore, {
      tempMission: makeMission(),
      request,
      now,
    });

    expect(outcome).toEqual({ status: 'committed', mission: serverMission });

    const state = useMissionStore.getState();
    // Le serveur a assigné 'srv_new' — il est dans le store, confirmé.
    expect(state.missions['srv_new']).toBeDefined();
    expect(state.missions['srv_new']._meta.source).toBe('network');
    // Aucun résidu tmp_*.
    const tmpKeys = Object.keys(state.missions).filter(k => k.startsWith('tmp_'));
    expect(tmpKeys).toHaveLength(0);
    // Persistance déclenchée.
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("réseau échoue → failed : retire l'entrée tmp, ApiError retournée", async () => {
    const networkError = new ApiError('NETWORK_ERROR', 0);
    const request = jest.fn().mockRejectedValue(networkError);

    const outcome = await withOptimisticCreate(useMissionStore, {
      tempMission: makeMission(),
      request,
      now,
    });

    expect(outcome).toEqual({ status: 'failed', error: networkError });
    // Aucune trace dans le store.
    expect(Object.keys(useMissionStore.getState().missions)).toHaveLength(0);
    // Pas de persistance sur échec.
    expect(setItem).not.toHaveBeenCalled();
  });

  it("5xx → failed : l'entrée tmp est retirée proprement", async () => {
    const serverError = new ApiError('HTTP_500', 500);
    const request = jest.fn().mockRejectedValue(serverError);

    const outcome = await withOptimisticCreate(useMissionStore, {
      tempMission: makeMission(),
      request,
      now,
    });

    expect(outcome.status).toBe('failed');
    expect(Object.keys(useMissionStore.getState().missions)).toHaveLength(0);
  });

  it('la mission apparaît AVANT la résolution réseau (optimisme visible dans le store)', async () => {
    let capturedMissionsSnapshot: number | null = null;
    const request = jest.fn().mockImplementation(async () => {
      // Au moment où request() est en attente, la mission doit déjà être dans le store.
      capturedMissionsSnapshot = Object.keys(useMissionStore.getState().missions).length;
      return makeMission({ id: 'srv_id' });
    });

    await withOptimisticCreate(useMissionStore, { tempMission: makeMission(), request, now });

    expect(capturedMissionsSnapshot).toBe(1); // visible pendant l'appel réseau
    expect(Object.keys(useMissionStore.getState().missions)).toHaveLength(1); // confirmée après
  });

  it("deux créations parallèles génèrent des IDs distincts et les deux se commitent", async () => {
    const srv1 = makeMission({ id: 'srv_1' });
    const srv2 = makeMission({ id: 'srv_2' });

    const [r1, r2] = await Promise.all([
      withOptimisticCreate(useMissionStore, {
        tempMission: makeMission({ id: 'placeholder1' }),
        request: jest.fn().mockResolvedValue(srv1),
        now,
      }),
      withOptimisticCreate(useMissionStore, {
        tempMission: makeMission({ id: 'placeholder2' }),
        request: jest.fn().mockResolvedValue(srv2),
        now,
      }),
    ]);

    expect(r1.status).toBe('committed');
    expect(r2.status).toBe('committed');
    const state = useMissionStore.getState();
    expect(state.missions['srv_1']).toBeDefined();
    expect(state.missions['srv_2']).toBeDefined();
    // Aucun résidu tmp_*.
    const tmpKeys = Object.keys(state.missions).filter(k => k.startsWith('tmp_'));
    expect(tmpKeys).toHaveLength(0);
  });
});
