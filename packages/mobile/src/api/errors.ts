// Erreurs API normalisées (typées) — exposées aux écrans à la place de l'erreur
// Axios brute. AUCUN champ ne porte de token (header `Authorization`, body, etc.) :
// les écrans peuvent logger librement une `ApiError` sans risquer une fuite.
//
// Le `code` reflète la convention backend (`{ error: 'SNAKE_CASE_CODE' }`,
// cf. src/app.ts `setErrorHandler`). Pour les pannes hors-protocole (réseau,
// timeout, parse), on définit nos propres codes locaux.

import type { AxiosError } from 'axios';
import { isAxiosError } from 'axios';

export class ApiError extends Error {
  /** Code métier backend (`UNAUTHORIZED`, `INVALID_CREDENTIALS`, …) ou local (`NETWORK_ERROR`, …). */
  readonly code: string;
  /** Statut HTTP si la requête a abouti, sinon 0 (pas de réponse). */
  readonly status: number;
  /**
   * Contexte métier structuré joint par le backend sous `details` (cf. `setErrorHandler`).
   * Ex. 409 `VERSION_CONFLICT` → `{ currentVersion, expectedVersion }`. JAMAIS de secret
   * (le backend n'y met que du contexte métier) : `console.log(err)` reste sûr.
   */
  readonly details?: unknown;

  constructor(code: string, status: number, details?: unknown, message?: string) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Convertit une `AxiosError` en `ApiError` en EXTRAYANT le code métier du body
 * (`{ error: '...', details? }`) quand il est présent, sans logger token/URL/Authorization.
 */
export function normalizeAxiosError(err: AxiosError): ApiError {
  if (err.response !== undefined) {
    const body = err.response.data as { error?: unknown; details?: unknown } | undefined;
    const code =
      typeof body?.error === 'string' && body.error.length > 0
        ? body.error
        : `HTTP_${err.response.status}`;
    return new ApiError(code, err.response.status, body?.details);
  }
  // Pas de réponse : panne réseau / timeout / DNS / serveur down.
  return new ApiError('NETWORK_ERROR', 0);
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) {
    return err;
  }
  if (isAxiosError(err)) {
    return normalizeAxiosError(err);
  }
  return new ApiError('UNKNOWN_ERROR', 0);
}
