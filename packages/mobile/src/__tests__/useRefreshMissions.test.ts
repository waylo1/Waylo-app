// Suite useRefreshMissions — refresh OK, réseau coupé, anti-spam.
//
// `listMissions` est mocké au niveau module.
// `useToastStore` est mocké pour capturer les appels `showToast` sans monter Toast.tsx.
// `renderHook` + `act` de @testing-library/react-native pour les mises à jour d'état.

import { act, renderHook } from '@testing-library/react-native';
import type { MissionDTO } from '@waylo/shared';
import { ApiError } from '../api/errors';
import { useRefreshMissions } from '../hooks/useRefreshMissions';

// -- Mocks -------------------------------------------------------------------

const mockListMissions = jest.fn<Promise<MissionDTO[]>, []>();
jest.mock('../api/missions.api', () => ({
  listMissions: (...args: []) => mockListMissions(...args),
}));

const mockShowToast = jest.fn();
jest.mock('../feedback/toast.store', () => ({
  useToastStore: (selector: (s: { showToast: typeof mockShowToast }) => unknown) =>
    selector({ showToast: mockShowToast }),
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
});

// ============================================================================
// Refresh réussi
// ============================================================================

describe('refresh réseau OK', () => {
  it('appelle listMissions et syncMissions avec les données fraîches', async () => {
    const freshMissions = [makeMission({ id: 'm1' }), makeMission({ id: 'm2' })];
    mockListMissions.mockResolvedValueOnce(freshMissions);
    const syncMissions = jest.fn();

    const { result } = renderHook(() => useRefreshMissions({ syncMissions }));
    expect(result.current.isRefreshing).toBe(false);

    await act(async () => {
      result.current.onRefresh();
    });

    expect(mockListMissions).toHaveBeenCalledTimes(1);
    expect(syncMissions).toHaveBeenCalledWith(freshMissions, expect.any(Number));
    expect(result.current.isRefreshing).toBe(false);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('isRefreshing passe à true pendant le fetch puis revient à false', async () => {
    let resolveFn!: (v: MissionDTO[]) => void;
    mockListMissions.mockReturnValueOnce(new Promise(r => { resolveFn = r; }));
    const syncMissions = jest.fn();

    const { result } = renderHook(() => useRefreshMissions({ syncMissions }));

    // Démarre le refresh sans await pour observer l'état intermédiaire.
    act(() => { result.current.onRefresh(); });
    expect(result.current.isRefreshing).toBe(true);

    // Résout la promesse.
    await act(async () => { resolveFn([]); });
    expect(result.current.isRefreshing).toBe(false);
  });
});

// ============================================================================
// Réseau coupé
// ============================================================================

describe('refresh réseau coupé', () => {
  it('affiche un toast erreur, isRefreshing repasse à false, syncMissions non appelé', async () => {
    mockListMissions.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0));
    const syncMissions = jest.fn();

    const { result } = renderHook(() => useRefreshMissions({ syncMissions }));

    await act(async () => {
      result.current.onRefresh();
    });

    expect(syncMissions).not.toHaveBeenCalled();
    expect(result.current.isRefreshing).toBe(false);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('NETWORK_ERROR'),
      'error',
    );
  });

  it('HTTP 500 → toast erreur avec le code HTTP', async () => {
    mockListMissions.mockRejectedValueOnce(new ApiError('HTTP_500', 500));
    const syncMissions = jest.fn();

    const { result } = renderHook(() => useRefreshMissions({ syncMissions }));

    await act(async () => {
      result.current.onRefresh();
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('HTTP_500'),
      'error',
    );
  });
});

// ============================================================================
// Anti-spam
// ============================================================================

describe('anti-spam', () => {
  it('ignore un second pull pendant que le premier est en cours', async () => {
    let resolveFn!: (v: MissionDTO[]) => void;
    mockListMissions.mockReturnValueOnce(new Promise(r => { resolveFn = r; }));
    const syncMissions = jest.fn();

    const { result } = renderHook(() => useRefreshMissions({ syncMissions }));

    // Premier pull.
    act(() => { result.current.onRefresh(); });
    expect(result.current.isRefreshing).toBe(true);

    // Second pull pendant que le premier est en vol → ignoré.
    act(() => { result.current.onRefresh(); });

    // Résout le premier.
    await act(async () => { resolveFn([]); });

    // listMissions n'a été appelé qu'une seule fois.
    expect(mockListMissions).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
  });

  it('un nouveau pull est accepté après la fin du précédent', async () => {
    mockListMissions
      .mockResolvedValueOnce([makeMission({ id: 'a' })])
      .mockResolvedValueOnce([makeMission({ id: 'b' })]);
    const syncMissions = jest.fn();

    const { result } = renderHook(() => useRefreshMissions({ syncMissions }));

    await act(async () => { result.current.onRefresh(); });
    await act(async () => { result.current.onRefresh(); });

    expect(mockListMissions).toHaveBeenCalledTimes(2);
    expect(syncMissions).toHaveBeenCalledTimes(2);
  });
});
