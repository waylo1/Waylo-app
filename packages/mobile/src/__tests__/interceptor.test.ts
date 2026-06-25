// Suite interceptors — teste client.ts via axios-mock-adapter attaché à
// l'instance RÉELLE `apiClient` (qui porte les interceptors).
//
// Flux vérifié :
//   requête → intercepteur REQUEST (injection Bearer) → MockAdapter → réponse
//   → intercepteur RESPONSE (401 → clearSession, erreur typée ApiError)
//
// Sécurité : vérifie qu'aucun console.* n'expose le token lors d'un 401.

import MockAdapter from 'axios-mock-adapter';
import { apiClient } from '../api/client';
import { useAuthStore } from '../auth/auth.store';
import { ApiError } from '../api/errors';
import { MOCK_SESSION, MOCK_TOKEN } from './fixtures';

const mockAxios = new MockAdapter(apiClient);

beforeEach(() => {
  mockAxios.reset();
  jest.clearAllMocks();
  // Remettre le store dans un état propre (sans session).
  useAuthStore.setState({ status: 'unauthenticated', session: null });
});

afterAll(() => {
  mockAxios.restore();
});

// ============================================================================
// Intercepteur REQUEST — injection du Bearer token
// ============================================================================

describe('request interceptor', () => {
  test('Bearer injecté depuis AuthStore quand session présente', async () => {
    useAuthStore.setState({ status: 'authenticated', session: MOCK_SESSION });

    let capturedAuth: string | undefined;
    mockAxios.onGet('/test').reply((config) => {
      capturedAuth = (config.headers as Record<string, string>)['Authorization'];
      return [200, {}];
    });

    await apiClient.get('/test');

    expect(capturedAuth).toBe(`Bearer ${MOCK_TOKEN}`);
  });

  test('pas de header Authorization quand aucune session', async () => {
    useAuthStore.setState({ status: 'unauthenticated', session: null });

    let capturedAuth: string | undefined;
    mockAxios.onGet('/no-auth').reply((config) => {
      capturedAuth = (config.headers as Record<string, string>)['Authorization'];
      return [200, {}];
    });

    await apiClient.get('/no-auth');

    expect(capturedAuth).toBeUndefined();
  });
});

// ============================================================================
// Intercepteur RESPONSE — gestion des erreurs
// ============================================================================

describe('response interceptor', () => {
  test('401 → clearSession fire-and-forget, ApiError propagée', async () => {
    const mockClearSession = jest.fn().mockResolvedValue(undefined);
    useAuthStore.setState({
      status: 'authenticated',
      session: MOCK_SESSION,
      clearSession: mockClearSession,
    });

    mockAxios.onGet('/protected').reply(401, { error: 'UNAUTHORIZED' });

    await expect(apiClient.get('/protected')).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });

    // clearSession est fire-and-forget — appelé synchroniquement dans l'intercepteur.
    expect(mockClearSession).toHaveBeenCalledTimes(1);
  });

  test('401 sans retry — une seule requête sortante', async () => {
    const mockClearSession = jest.fn().mockResolvedValue(undefined);
    useAuthStore.setState({
      status: 'authenticated',
      session: MOCK_SESSION,
      clearSession: mockClearSession,
    });

    mockAxios.onGet('/one-shot').reply(401, { error: 'UNAUTHORIZED' });

    await expect(apiClient.get('/one-shot')).rejects.toBeDefined();

    // MockAdapter compte les requêtes effectivement émises.
    expect(mockAxios.history['get']).toHaveLength(1);
  });

  test('5xx → ApiError typée propagée, clearSession NON appelé', async () => {
    const mockClearSession = jest.fn().mockResolvedValue(undefined);
    useAuthStore.setState({
      status: 'authenticated',
      session: MOCK_SESSION,
      clearSession: mockClearSession,
    });

    mockAxios.onGet('/server-err').reply(500, { error: 'INTERNAL_ERROR' });

    const err = await apiClient.get('/server-err').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL_ERROR');
    expect((err as ApiError).status).toBe(500);
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  test('erreur réseau (pas de réponse) → ApiError NETWORK_ERROR / status 0', async () => {
    mockAxios.onGet('/offline').networkError();

    const err = await apiClient.get('/offline').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
    expect((err as ApiError).status).toBe(0);
  });

  // Sécurité : le token ne doit jamais apparaître dans les logs console.
  test('SÉCURITÉ — token absent des logs console sur 401', async () => {
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const mockClearSession = jest.fn().mockResolvedValue(undefined);
    useAuthStore.setState({
      status: 'authenticated',
      session: MOCK_SESSION,
      clearSession: mockClearSession,
    });

    mockAxios.onGet('/leak-check').reply(401, { error: 'UNAUTHORIZED' });

    await expect(apiClient.get('/leak-check')).rejects.toBeDefined();

    const allOutput = [
      ...consoleSpy.mock.calls.flat(),
      ...warnSpy.mock.calls.flat(),
    ]
      .map(String)
      .join(' ');

    expect(allOutput).not.toContain(MOCK_TOKEN);

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
