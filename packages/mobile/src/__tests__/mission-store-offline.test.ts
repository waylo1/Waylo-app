// Suite mission.store — hydratation offline-first + persistance SecureStore.
//
// `missions-secure-store` est mocké au niveau module pour isoler le store
// de l'I/O natif SecureStore.

import type { MissionDTO } from '@waylo/shared';
import type { MissionCacheEntry } from '../missions/mission.store.types';
import { useMissionStore } from '../missions/mission.store';

// -- Mocks -------------------------------------------------------------------
// jest.mock() est hoissté par babel-jest : les variables mockRead/etc. sont
// disponibles dans la factory même si déclarées après les imports.

const mockRead = jest.fn<Promise<MissionCacheEntry | null>, []>();
const mockWrite = jest.fn<Promise<void>, [MissionCacheEntry]>();
const mockClear = jest.fn<Promise<void>, []>();

jest.mock('../missions/missions-secure-store', () => ({
  readMissionsCache: (...args: []) => mockRead(...args),
  writeMissionsCache: (...args: Parameters<typeof mockWrite>) => mockWrite(...args),
  clearMissionsCache: (...args: []) => mockClear(...args),
}));

// -- Fixtures ----------------------------------------------------------------

function makeMission(overrides: Partial<MissionDTO> = {}): MissionDTO {
  return {
    id: 'm1',
    buyerId: 'buyer1',
    travelerId: null,
    status: 'AWAITING_VALIDATION',
    targetProduct: 'Sac',
    budgetCents: 10_000,
    commissionCents: 1_000,
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

beforeEach(() => {
  jest.clearAllMocks();
  // Réinitialise l'état du store entre chaque test.
  useMissionStore.setState({
    missions: [],
    lastSyncedAt: null,
    isLoadingInitial: true,
    error: null,
  });
});

// ============================================================================
// hydrate — avec cache
// ============================================================================

describe('hydrate — cache présent', () => {
  it('hydrate avec cache → remplit missions + lastSyncedAt, isLoadingInitial=false', async () => {
    const missions = [makeMission({ id: 'm1' }), makeMission({ id: 'm2' })];
    mockRead.mockResolvedValueOnce({ missions, lastSyncedAt: 1_700_000_000_000 });

    await useMissionStore.getState().hydrate();

    const state = useMissionStore.getState();
    expect(state.missions).toEqual(missions);
    expect(state.lastSyncedAt).toBe(1_700_000_000_000);
    expect(state.isLoadingInitial).toBe(false);
    expect(state.error).toBeNull();
  });

  it('hydrate avec cache → isLoadingInitial passe à false (plus de spinner)', async () => {
    mockRead.mockResolvedValueOnce({ missions: [], lastSyncedAt: 0 });

    expect(useMissionStore.getState().isLoadingInitial).toBe(true);
    await useMissionStore.getState().hydrate();
    expect(useMissionStore.getState().isLoadingInitial).toBe(false);
  });
});

// ============================================================================
// hydrate — sans cache
// ============================================================================

describe('hydrate — cache absent', () => {
  it('hydrate sans cache → missions=[], lastSyncedAt=null, isLoadingInitial=false', async () => {
    mockRead.mockResolvedValueOnce(null);

    await useMissionStore.getState().hydrate();

    const state = useMissionStore.getState();
    expect(state.missions).toEqual([]);
    expect(state.lastSyncedAt).toBeNull();
    expect(state.isLoadingInitial).toBe(false);
  });
});

// ============================================================================
// hydrate — SecureStore inaccessible
// ============================================================================

describe('hydrate — SecureStore inaccessible', () => {
  it('erreur SecureStore → isLoadingInitial=false, pas de crash', async () => {
    mockRead.mockRejectedValueOnce(new Error('SecureStore unavailable'));

    await useMissionStore.getState().hydrate();

    const state = useMissionStore.getState();
    expect(state.isLoadingInitial).toBe(false);
    expect(state.missions).toEqual([]);
  });
});

// ============================================================================
// syncMissions
// ============================================================================

describe('syncMissions', () => {
  it('met à jour missions + lastSyncedAt + efface error', () => {
    useMissionStore.setState({ error: 'old error' });
    mockWrite.mockResolvedValue(undefined);

    const missions = [makeMission()];
    useMissionStore.getState().syncMissions(missions, 9999);

    const state = useMissionStore.getState();
    expect(state.missions).toEqual(missions);
    expect(state.lastSyncedAt).toBe(9999);
    expect(state.error).toBeNull();
  });

  it('appelle writeMissionsCache avec les données fraîches', async () => {
    mockWrite.mockResolvedValue(undefined);

    const missions = [makeMission({ id: 'a' }), makeMission({ id: 'b' })];
    useMissionStore.getState().syncMissions(missions, 12345);

    // Fire-and-forget : on attend la microtask
    await Promise.resolve();

    expect(mockWrite).toHaveBeenCalledWith({
      missions: expect.arrayContaining([
        expect.objectContaining({ id: 'a' }),
        expect.objectContaining({ id: 'b' }),
      ]),
      lastSyncedAt: 12345,
    });
  });

  it("writeMissionsCache en échec ne fait pas crasher le store", async () => {
    mockWrite.mockRejectedValueOnce(new Error('disk full'));

    expect(() => {
      useMissionStore.getState().syncMissions([makeMission()], 1);
    }).not.toThrow();

    // Laisse la promesse fire-and-forget se résoudre (rejetée silencieusement)
    await Promise.resolve();
  });
});

// ============================================================================
// setError / setLoadingInitial
// ============================================================================

describe('setError / setLoadingInitial', () => {
  it('setError met à jour error', () => {
    useMissionStore.getState().setError('NETWORK_ERROR');
    expect(useMissionStore.getState().error).toBe('NETWORK_ERROR');
  });

  it('setError(null) efface error', () => {
    useMissionStore.setState({ error: 'boom' });
    useMissionStore.getState().setError(null);
    expect(useMissionStore.getState().error).toBeNull();
  });

  it('setLoadingInitial bascule isLoadingInitial', () => {
    useMissionStore.getState().setLoadingInitial(false);
    expect(useMissionStore.getState().isLoadingInitial).toBe(false);
    useMissionStore.getState().setLoadingInitial(true);
    expect(useMissionStore.getState().isLoadingInitial).toBe(true);
  });
});
