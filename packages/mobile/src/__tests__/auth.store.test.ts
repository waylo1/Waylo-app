// Suite auth.store — couvre hydrate (200 / 401 / réseau / single-flight)
// ainsi que setSession / clearSession.
//
// Stratégie d'isolation : jest.resetModules() dans beforeEach + jest.doMock()
// pour les tests hydrate.  `hydrationPromise` est une variable de module
// (jamais remise à null après la première résolution) ; resetModules() recharge
// le module avec un état propre à chaque test.

import { MOCK_FRESH_USER, MOCK_SESSION, MOCK_TOKEN } from './fixtures';

// -- Types -------------------------------------------------------------------

type AuthStoreModule = typeof import('../auth/auth.store');

// -- Helpers -----------------------------------------------------------------

function makeSecureStoreMock(stored: import('@waylo/shared').SessionDTO | null = null) {
  return {
    readSession: jest.fn().mockResolvedValue(stored),
    writeSession: jest.fn().mockResolvedValue(undefined),
    clearStoredSession: jest.fn().mockResolvedValue(undefined),
  };
}

function makeAuthApiMock(userResult: import('@waylo/shared').UserDTO | Error) {
  const getMock =
    userResult instanceof Error
      ? jest.fn().mockRejectedValue(userResult)
      : jest.fn().mockResolvedValue(userResult);
  return { getMe: getMock };
}

// Recharge auth.store dans un registre isolé avec les mocks déjà posés.
function loadFreshStore(): AuthStoreModule['useAuthStore'] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../auth/auth.store') as AuthStoreModule).useAuthStore;
}

// -- Hooks globaux -----------------------------------------------------------

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
});

// ============================================================================
// hydrate
// ============================================================================

describe('hydrate — 200 OK', () => {
  test('user rafraîchi depuis la réponse serveur', async () => {
    jest.doMock('../auth/secure-store', () => makeSecureStoreMock(MOCK_SESSION));
    jest.doMock('../api/auth.api', () => makeAuthApiMock(MOCK_FRESH_USER));

    const store = loadFreshStore();
    await store.getState().hydrate();

    const { status, session } = store.getState();
    expect(status).toBe('authenticated');
    expect(session?.user).toEqual(MOCK_FRESH_USER);
    expect(session?.token).toBe(MOCK_TOKEN);
  });

  test('getMe appelé avec le token stocké', async () => {
    const getMeMock = jest.fn().mockResolvedValue(MOCK_FRESH_USER);
    jest.doMock('../auth/secure-store', () => makeSecureStoreMock(MOCK_SESSION));
    jest.doMock('../api/auth.api', () => ({ getMe: getMeMock }));

    const store = loadFreshStore();
    await store.getState().hydrate();

    expect(getMeMock).toHaveBeenCalledWith(MOCK_SESSION.token);
  });

  test('session écrite en SecureStore avec user rafraîchi', async () => {
    const writeMock = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../auth/secure-store', () => ({
      readSession: jest.fn().mockResolvedValue(MOCK_SESSION),
      writeSession: writeMock,
      clearStoredSession: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../api/auth.api', () => makeAuthApiMock(MOCK_FRESH_USER));

    const store = loadFreshStore();
    await store.getState().hydrate();

    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({ user: MOCK_FRESH_USER }),
    );
  });
});

describe('hydrate — pas de session stockée', () => {
  test('status → unauthenticated sans appel réseau', async () => {
    const getMeMock = jest.fn();
    jest.doMock('../auth/secure-store', () => makeSecureStoreMock(null));
    jest.doMock('../api/auth.api', () => ({ getMe: getMeMock }));

    const store = loadFreshStore();
    await store.getState().hydrate();

    expect(store.getState().status).toBe('unauthenticated');
    expect(store.getState().session).toBeNull();
    expect(getMeMock).not.toHaveBeenCalled();
  });
});

describe('hydrate — 401 (rejet actif)', () => {
  test('clearSession appelé, status → unauthenticated', async () => {
    const clearMock = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../auth/secure-store', () => ({
      readSession: jest.fn().mockResolvedValue(MOCK_SESSION),
      writeSession: jest.fn().mockResolvedValue(undefined),
      clearStoredSession: clearMock,
    }));
    // Factory exécutée lors du require de auth.store : ApiError provient alors du
    // MÊME registre de module que toApiError → instanceof correct.
    jest.doMock('../api/auth.api', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ApiError: E } = require('../api/errors') as typeof import('../api/errors');
      return { getMe: jest.fn().mockRejectedValue(new E('UNAUTHORIZED', 401)) };
    });

    const store = loadFreshStore();
    await store.getState().hydrate();

    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('unauthenticated');
    expect(store.getState().session).toBeNull();
  });
});

describe('hydrate — erreur réseau / 5xx (optimisme MOB-06)', () => {
  test('session GARDÉE, clearSession NON appelé', async () => {
    const clearMock = jest.fn().mockResolvedValue(undefined);

    jest.doMock('../auth/secure-store', () => ({
      readSession: jest.fn().mockResolvedValue(MOCK_SESSION),
      writeSession: jest.fn().mockResolvedValue(undefined),
      clearStoredSession: clearMock,
    }));
    jest.doMock('../api/auth.api', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ApiError: E } = require('../api/errors') as typeof import('../api/errors');
      return { getMe: jest.fn().mockRejectedValue(new E('NETWORK_ERROR', 0)) };
    });

    const store = loadFreshStore();
    await store.getState().hydrate();

    expect(clearMock).not.toHaveBeenCalled();
    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().session).toEqual(MOCK_SESSION);
  });

  test('erreur 5xx → session GARDÉE', async () => {
    jest.doMock('../auth/secure-store', () => makeSecureStoreMock(MOCK_SESSION));
    jest.doMock('../api/auth.api', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ApiError: E } = require('../api/errors') as typeof import('../api/errors');
      return { getMe: jest.fn().mockRejectedValue(new E('HTTP_503', 503)) };
    });

    const store = loadFreshStore();
    await store.getState().hydrate();

    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().session).toEqual(MOCK_SESSION);
  });
});

describe('hydrate — single-flight', () => {
  test('2 appels concurrents → 1 seul GET /me', async () => {
    const getMeMock = jest.fn().mockResolvedValue(MOCK_FRESH_USER);
    jest.doMock('../auth/secure-store', () => makeSecureStoreMock(MOCK_SESSION));
    jest.doMock('../api/auth.api', () => ({ getMe: getMeMock }));

    const store = loadFreshStore();

    const p1 = store.getState().hydrate();
    const p2 = store.getState().hydrate();
    await Promise.all([p1, p2]);

    expect(getMeMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// setSession / clearSession
// ============================================================================

describe('setSession', () => {
  test('persiste en SecureStore et met à jour le store Zustand', async () => {
    const writeMock = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../auth/secure-store', () => ({
      readSession: jest.fn().mockResolvedValue(null),
      writeSession: writeMock,
      clearStoredSession: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../api/auth.api', () => ({ getMe: jest.fn() }));

    const store = loadFreshStore();
    await store.getState().setSession(MOCK_SESSION);

    expect(writeMock).toHaveBeenCalledWith(MOCK_SESSION);
    expect(store.getState().status).toBe('authenticated');
    expect(store.getState().session).toEqual(MOCK_SESSION);
  });
});

describe('clearSession', () => {
  test('purge SecureStore et vide le store Zustand', async () => {
    const clearMock = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../auth/secure-store', () => ({
      readSession: jest.fn().mockResolvedValue(null),
      writeSession: jest.fn().mockResolvedValue(undefined),
      clearStoredSession: clearMock,
    }));
    jest.doMock('../api/auth.api', () => ({ getMe: jest.fn() }));

    const store = loadFreshStore();
    store.setState({ status: 'authenticated', session: MOCK_SESSION });
    await store.getState().clearSession();

    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('unauthenticated');
    expect(store.getState().session).toBeNull();
  });

  test('getSession retourne null après clearSession', async () => {
    jest.doMock('../auth/secure-store', () => ({
      readSession: jest.fn().mockResolvedValue(null),
      writeSession: jest.fn().mockResolvedValue(undefined),
      clearStoredSession: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock('../api/auth.api', () => ({ getMe: jest.fn() }));

    const store = loadFreshStore();
    store.setState({ status: 'authenticated', session: MOCK_SESSION });
    await store.getState().clearSession();

    expect(store.getState().getSession()).toBeNull();
  });
});

afterAll(() => {
  jest.restoreAllMocks();
});
