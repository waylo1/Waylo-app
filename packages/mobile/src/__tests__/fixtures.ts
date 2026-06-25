// Fixtures typées partagées entre toutes les suites de test MOB-07.
// Zéro `any` — toutes les valeurs respectent les contrats @waylo/shared.

import type { LoginRequest, LoginResponse, SessionDTO, UserDTO } from '@waylo/shared';

export const MOCK_USER: UserDTO = {
  id: 'cuid_test_user_001',
  email: 'test@waylo.com',
  kycStatus: 'PENDING' as UserDTO['kycStatus'],
  createdAt: '2024-01-15T10:00:00.000Z',
};

export const MOCK_FRESH_USER: UserDTO = {
  ...MOCK_USER,
  email: 'refreshed@waylo.com',
};

// Token JWT synthétique — structure valide mais non signé (tests seulement).
export const MOCK_TOKEN = 'test.jwt.token_abc123';

export const MOCK_SESSION: SessionDTO = {
  token: MOCK_TOKEN,
  claims: { sub: MOCK_USER.id },
  user: MOCK_USER,
};

export const MOCK_LOGIN_REQUEST: LoginRequest = {
  email: MOCK_USER.email,
  password: 'correcthorse',
};

export const MOCK_LOGIN_RESPONSE: LoginResponse = {
  token: MOCK_TOKEN,
};
