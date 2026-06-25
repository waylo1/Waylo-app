// Client API missions — wrappers typés pour les routes /api/missions.
//
// Routes câblées (monté sous /api/missions dans crud.route.ts et validation.route.ts) :
// - GET  /api/missions               → MissionDTO[]
// - POST /api/missions               → MissionDTO (status CREATED, version 0)
// - POST /api/missions/:id/validate  → MissionDTO (AWAITING_VALIDATION → VALIDATED)
// - POST /api/missions/:id/confirm-receipt → MissionDTO (même transition, via reçu)
//
// `expectedVersion` est optionnel (rétrocompat) : absent = pas de contrôle de version.
// Si présent et divergent du backend → 409 VERSION_CONFLICT (cf. SHARED-409).

import { apiClient } from './client';
import type { MissionDTO } from '@waylo/shared';

/** Champs envoyés par le client pour créer une mission (cf. crud.route.ts body schema). */
export interface CreateMissionInput {
  readonly targetProduct: string;
  readonly budgetCents: number;
  readonly commissionCents: number;
  readonly origin: string;
  readonly destination: string;
  /** Code pays ISO 3166-1 alpha-2 (2 lettres). */
  readonly destinationCountry: string;
  /** ISO 8601 — doit être dans le futur. */
  readonly expiresAt: string;
  readonly substitutionAuthorized?: boolean;
}

export async function listMissions(): Promise<MissionDTO[]> {
  const res = await apiClient.get<MissionDTO[]>('/api/missions');
  return res.data;
}

export async function createMission(input: CreateMissionInput): Promise<MissionDTO> {
  const res = await apiClient.post<MissionDTO>('/api/missions', input);
  return res.data;
}

export async function validateMission(id: string, expectedVersion?: number): Promise<MissionDTO> {
  const body = expectedVersion !== undefined ? { expectedVersion } : undefined;
  const res = await apiClient.post<MissionDTO>(`/api/missions/${id}/validate`, body);
  return res.data;
}

export async function confirmReceipt(id: string, expectedVersion?: number): Promise<MissionDTO> {
  const body = expectedVersion !== undefined ? { expectedVersion } : undefined;
  const res = await apiClient.post<MissionDTO>(`/api/missions/${id}/confirm-receipt`, body);
  return res.data;
}
