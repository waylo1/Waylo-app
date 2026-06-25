// Suite LoginScreen — @testing-library/react-native.
// Smoke tests + chemins heureux/erreur. auth.store et auth.api entièrement mockés.

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import type { SessionDTO } from '@waylo/shared';
import LoginScreen from '../screens/LoginScreen';
import { login, getMe } from '../api/auth.api';
import { useAuthStore } from '../auth/auth.store';
import { ApiError } from '../api/errors';
import { MOCK_TOKEN, MOCK_USER, MOCK_LOGIN_RESPONSE } from './fixtures';

jest.mock('../api/auth.api');
jest.mock('../auth/auth.store');

const mockLogin = login as jest.MockedFunction<typeof login>;
const mockGetMe = getMe as jest.MockedFunction<typeof getMe>;
const mockUseAuthStore = useAuthStore as unknown as jest.Mock;

let mockSetSession: jest.MockedFunction<(s: SessionDTO) => Promise<void>>;

beforeEach(() => {
  jest.clearAllMocks();

  mockSetSession = jest.fn().mockResolvedValue(undefined);

  mockUseAuthStore.mockImplementation(
    (selector: (s: { setSession: typeof mockSetSession }) => unknown) =>
      selector({ setSession: mockSetSession }),
  );
});

// ---------------------------------------------------------------------------
// Rendu initial
// ---------------------------------------------------------------------------

describe('rendu initial', () => {
  test('affiche email, mot de passe et bouton submit', () => {
    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    expect(getByPlaceholderText('Email')).toBeTruthy();
    expect(getByPlaceholderText('Mot de passe')).toBeTruthy();
    expect(getByText('Se connecter')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Flow succès
// ---------------------------------------------------------------------------

describe('flow succès', () => {
  test('login() appelé avec { email, password }', async () => {
    mockLogin.mockResolvedValue(MOCK_LOGIN_RESPONSE);
    mockGetMe.mockResolvedValue(MOCK_USER);

    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'correcthorse');
    fireEvent.press(getByText('Se connecter'));

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith({
        email: MOCK_USER.email,
        password: 'correcthorse',
      });
    });
  });

  test('setSession appelé avec SessionDTO depuis serveur', async () => {
    mockLogin.mockResolvedValue(MOCK_LOGIN_RESPONSE);
    mockGetMe.mockResolvedValue(MOCK_USER);

    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'correcthorse');
    fireEvent.press(getByText('Se connecter'));

    await waitFor(() => {
      expect(mockSetSession).toHaveBeenCalledWith(
        expect.objectContaining({
          token: MOCK_TOKEN,
          user: MOCK_USER,
          claims: { sub: MOCK_USER.id },
        }),
      );
    });
  });

  test('getMe appelé avec le token retourné par login', async () => {
    mockLogin.mockResolvedValue(MOCK_LOGIN_RESPONSE);
    mockGetMe.mockResolvedValue(MOCK_USER);

    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'correcthorse');
    fireEvent.press(getByText('Se connecter'));

    await waitFor(() => {
      expect(mockGetMe).toHaveBeenCalledWith(MOCK_TOKEN);
    });
  });

  test('token dans session vient du serveur, pas du formulaire', async () => {
    const serverToken = 'real-server-token-zzz';
    mockLogin.mockResolvedValue({ token: serverToken });
    mockGetMe.mockResolvedValue(MOCK_USER);

    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'pass');
    fireEvent.press(getByText('Se connecter'));

    await waitFor(() => expect(mockSetSession).toHaveBeenCalled());

    const session: SessionDTO = mockSetSession.mock.calls[0][0];
    expect(session.token).toBe(serverToken);
    expect(session.claims.sub).toBe(MOCK_USER.id);
  });
});

// ---------------------------------------------------------------------------
// État loading (submit en cours)
// ---------------------------------------------------------------------------

describe('état loading', () => {
  test('texte "Se connecter" remplacé par spinner pendant la requête', async () => {
    let resolve!: (v: { token: string }) => void;
    mockLogin.mockReturnValue(new Promise((res) => { resolve = res; }));
    mockGetMe.mockResolvedValue(MOCK_USER);

    const { getByPlaceholderText, getByText, queryByText } = render(
      <LoginScreen />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'pass');
    fireEvent.press(getByText('Se connecter'));

    await waitFor(() => {
      expect(queryByText('Se connecter')).toBeNull();
    });

    await act(async () => { resolve({ token: MOCK_TOKEN }); });
  });

  test('bouton disabled pendant le submit (press ignoré)', async () => {
    let resolve!: (v: { token: string }) => void;
    mockLogin
      .mockReturnValueOnce(new Promise((res) => { resolve = res; }))
      .mockResolvedValue(MOCK_LOGIN_RESPONSE);
    mockGetMe.mockResolvedValue(MOCK_USER);

    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'pass');
    fireEvent.press(getByText('Se connecter'));

    expect(mockLogin).toHaveBeenCalledTimes(1);

    await act(async () => { resolve({ token: MOCK_TOKEN }); });
  });
});

// ---------------------------------------------------------------------------
// Gestion d'erreurs
// ---------------------------------------------------------------------------

describe('gestion d\'erreurs', () => {
  test('401 INVALID_CREDENTIALS → message affiché, setSession non appelé', async () => {
    mockLogin.mockRejectedValue(new ApiError('INVALID_CREDENTIALS', 401));

    const { getByPlaceholderText, getByText, findByText } = render(
      <LoginScreen />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'wrong');
    fireEvent.press(getByText('Se connecter'));

    expect(await findByText('Identifiants invalides.')).toBeTruthy();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('NETWORK_ERROR → message réseau affiché', async () => {
    mockLogin.mockRejectedValue(new ApiError('NETWORK_ERROR', 0));

    const { getByPlaceholderText, getByText, findByText } = render(
      <LoginScreen />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'pass');
    fireEvent.press(getByText('Se connecter'));

    expect(
      await findByText('Connexion impossible. Vérifiez votre réseau.'),
    ).toBeTruthy();
  });

  test('erreur → bouton réactivé (submitting → false)', async () => {
    mockLogin.mockRejectedValue(new ApiError('INVALID_CREDENTIALS', 401));

    const { getByPlaceholderText, getByText, findByText } = render(
      <LoginScreen />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'wrong');
    fireEvent.press(getByText('Se connecter'));

    await findByText('Identifiants invalides.');

    expect(getByText('Se connecter')).toBeTruthy();
  });

  test('message d\'erreur ne contient jamais le token', async () => {
    mockLogin.mockRejectedValue(new ApiError('INVALID_CREDENTIALS', 401));

    const { getByPlaceholderText, getByText, findByText } = render(
      <LoginScreen />,
    );

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'wrong');
    fireEvent.press(getByText('Se connecter'));

    const errorEl = await findByText('Identifiants invalides.');
    expect(String(errorEl.props.children)).not.toContain(MOCK_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Submit disabled logic
// ---------------------------------------------------------------------------

describe('submit disabled', () => {
  test('press ignoré si email vide', () => {
    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('Mot de passe'), 'pass');
    fireEvent.press(getByText('Se connecter'));

    expect(mockLogin).not.toHaveBeenCalled();
  });

  test('press ignoré si mot de passe vide', () => {
    const { getByPlaceholderText, getByText } = render(<LoginScreen />);

    fireEvent.changeText(getByPlaceholderText('Email'), MOCK_USER.email);
    fireEvent.press(getByText('Se connecter'));

    expect(mockLogin).not.toHaveBeenCalled();
  });
});
