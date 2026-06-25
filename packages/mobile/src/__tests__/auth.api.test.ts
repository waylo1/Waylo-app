// Suite auth.api — vérifie que login() et getMe() appellent les bons
// endpoints avec les bons paramètres et mappent les erreurs en ApiError.
//
// axios-mock-adapter est attaché à l'instance RÉELLE (interceptors actifs),
// ce qui garantit que les erreurs passent bien par normalizeAxiosError.

import MockAdapter from 'axios-mock-adapter';
import { apiClient } from '../api/client';
import { login, getMe } from '../api/auth.api';
import { ApiError } from '../api/errors';
import {
  MOCK_LOGIN_REQUEST,
  MOCK_LOGIN_RESPONSE,
  MOCK_SESSION,
  MOCK_TOKEN,
  MOCK_USER,
} from './fixtures';
import { useAuthStore } from '../auth/auth.store';

const mockAxios = new MockAdapter(apiClient);

beforeEach(() => {
  mockAxios.reset();
  jest.clearAllMocks();
  // Pas de session → l'intercepteur request n'injectera pas de Bearer.
  useAuthStore.setState({ status: 'unauthenticated', session: null });
});

afterAll(() => {
  mockAxios.restore();
});

// ============================================================================
// login()
// ============================================================================

describe('login()', () => {
  test('POST /api/auth/login avec LoginRequest → LoginResponse', async () => {
    mockAxios
      .onPost('/api/auth/login', MOCK_LOGIN_REQUEST)
      .reply(200, MOCK_LOGIN_RESPONSE);

    const result = await login(MOCK_LOGIN_REQUEST);

    expect(result).toEqual(MOCK_LOGIN_RESPONSE);
    expect(result.token).toBe(MOCK_TOKEN);
  });

  test('body envoyé correspond à LoginRequest (email + password)', async () => {
    let capturedBody: unknown;
    mockAxios.onPost('/api/auth/login').reply((config) => {
      capturedBody = JSON.parse(config.data as string);
      return [200, MOCK_LOGIN_RESPONSE];
    });

    await login(MOCK_LOGIN_REQUEST);

    expect(capturedBody).toEqual({
      email: MOCK_LOGIN_REQUEST.email,
      password: MOCK_LOGIN_REQUEST.password,
    });
  });

  test('401 INVALID_CREDENTIALS → ApiError typée', async () => {
    mockAxios
      .onPost('/api/auth/login')
      .reply(401, { error: 'INVALID_CREDENTIALS' });

    const err = await login(MOCK_LOGIN_REQUEST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INVALID_CREDENTIALS');
    expect((err as ApiError).status).toBe(401);
  });

  test('panne réseau → ApiError NETWORK_ERROR', async () => {
    mockAxios.onPost('/api/auth/login').networkError();

    const err = await login(MOCK_LOGIN_REQUEST).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
    expect((err as ApiError).status).toBe(0);
  });
});

// ============================================================================
// getMe()
// ============================================================================

describe('getMe()', () => {
  test('GET /api/auth/me → UserDTO', async () => {
    mockAxios.onGet('/api/auth/me').reply(200, MOCK_USER);

    const result = await getMe();

    expect(result).toEqual(MOCK_USER);
  });

  test('token explicite injecté dans Authorization quand passé en argument', async () => {
    let capturedAuth: string | undefined;
    mockAxios.onGet('/api/auth/me').reply((config) => {
      capturedAuth = (config.headers as Record<string, string>)['Authorization'];
      return [200, MOCK_USER];
    });

    // Token explicite (flow post-login, avant que le store ne soit alimenté)
    await getMe(MOCK_TOKEN);

    expect(capturedAuth).toBe(`Bearer ${MOCK_TOKEN}`);
  });

  test('sans argument → header injecté par intercepteur depuis store', async () => {
    // Alimenter le store avec une session
    useAuthStore.setState({
      status: 'authenticated',
      session: MOCK_SESSION,
    });

    let capturedAuth: string | undefined;
    mockAxios.onGet('/api/auth/me').reply((config) => {
      capturedAuth = (config.headers as Record<string, string>)['Authorization'];
      return [200, MOCK_USER];
    });

    await getMe(); // pas de token explicite → intercepteur prend le relais

    expect(capturedAuth).toBe(`Bearer ${MOCK_TOKEN}`);
  });

  test('401 → ApiError (jamais axios brut)', async () => {
    mockAxios.onGet('/api/auth/me').reply(401, { error: 'UNAUTHORIZED' });

    // On remplace clearSession pour éviter le side-effect store
    useAuthStore.setState({
      clearSession: jest.fn().mockResolvedValue(undefined),
    });

    const err = await getMe().catch((e: unknown) => e);

    // La rejet doit être une ApiError, jamais une AxiosError brute.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UNAUTHORIZED');
  });
});
