// Cookie d'authentification HttpOnly — émis/lu sans dépendance externe.
// HttpOnly (inaccessible au JS → anti-XSS), SameSite=Strict (anti-CSRF),
// Secure en production. Le JWT (caractères URL-safe + points) tient en valeur
// de cookie sans encodage.
export const AUTH_COOKIE = 'waylo_token'
export const AUTH_COOKIE_MAX_AGE_SEC = 12 * 60 * 60 // miroir de TOKEN_TTL ('12h')

function attrs(maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

export function serializeAuthCookie(token: string): string {
  return `${AUTH_COOKIE}=${token}${attrs(AUTH_COOKIE_MAX_AGE_SEC)}`
}

export function clearAuthCookie(): string {
  return `${AUTH_COOKIE}=${attrs(0)}`
}

export function readAuthCookie(header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === AUTH_COOKIE) return part.slice(eq + 1).trim()
  }
  return null
}
