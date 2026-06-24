// Payloads d'authentification — miroir exact du contrat backend (src/auth/auth.route.ts,
// src/app.ts). Identité SEULE : aucun rôle de compte (« acheteur »/« voyageur » est
// contextuel, dérivé des relations Mission), aucun kycStatus figé dans le token.

/**
 * Corps des routes POST /api/auth/login et POST /api/auth/register.
 * (Register applique en plus une politique de longueur de mot de passe côté serveur.)
 */
export interface LoginRequest {
  email: string
  password: string
}

/**
 * Réponse de /api/auth/login et /api/auth/register : JWT d'identité.
 * Le même token est aussi posé en cookie HttpOnly (clients navigateur).
 */
export interface LoginResponse {
  token: string
}

/**
 * Claims du JWT Waylo — miroir exact du payload `@fastify/jwt` (src/app.ts).
 * `sub` = User.id (cuid). Aucune autre donnée : le KYC et les rôles sont relus
 * frais en base, jamais figés dans le token.
 */
export interface TokenClaims {
  sub: string
}
