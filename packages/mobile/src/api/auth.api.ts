// Wrappers typés pour les routes d'auth backend — single source of truth des
// chemins et formes côté mobile.
//
// Routes câblées (cf. src/auth/auth.route.ts, monté sous /api/auth) :
// - POST /api/auth/login → LoginRequest → LoginResponse
// - GET  /api/auth/me    → (Bearer requis) → UserDTO
//
// `getMe(token?)` accepte un token explicite : utilisé pendant le flow de login
// (où le token vient d'être obtenu mais n'est pas encore dans le store, donc
// l'intercepteur ne l'injecte pas). Sans argument, le header est posé par
// l'intercepteur (post-login, ou hydrate quand on veut valider la session
// stockée).

import { apiClient } from './client';
import type { LoginRequest, LoginResponse, UserDTO } from '@waylo/shared';

export async function login(body: LoginRequest): Promise<LoginResponse> {
  const res = await apiClient.post<LoginResponse>('/api/auth/login', body);
  return res.data;
}

export async function getMe(token?: string): Promise<UserDTO> {
  const config =
    token !== undefined
      ? { headers: { Authorization: `Bearer ${token}` } }
      : undefined;
  const res = await apiClient.get<UserDTO>('/api/auth/me', config);
  return res.data;
}
