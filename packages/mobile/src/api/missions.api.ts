// Client API missions — GET /api/missions (liste des missions de l'utilisateur courant).
// Seule fonction nécessaire pour le pull-to-refresh ; les mutations sont dans feat/ux-opt-01.

import { apiClient } from './client';
import type { MissionDTO } from '@waylo/shared';

export async function listMissions(): Promise<MissionDTO[]> {
  const res = await apiClient.get<MissionDTO[]>('/api/missions');
  return res.data;
}
