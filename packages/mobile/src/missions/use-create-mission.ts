// useCreateMission — hook acheteur pour créer une mission avec optimistic insert.
//
// La mission apparaît INSTANTANÉMENT dans la liste (ID temporaire `tmp_*`).
// On success : ID temporaire → ID serveur (commitCreate).
// On failure : entrée temporaire retirée + toast d'erreur.
//
// La création ne porte pas de `expectedVersion` (nouvelle ressource, pas de 409).

import { useCallback, useState } from 'react';
import { useMissionStore } from './mission.store';
import { withOptimisticCreate } from './optimistic';
import { createMission as createMissionApi } from '../api/missions.api';
import type { CreateMissionInput } from '../api/missions.api';
import { useAuthStore } from '../auth/auth.store';
import { useToastStore } from '../feedback/toast.store';
import type { MissionDTO } from '@waylo/shared';

/** Construit un MissionDTO temporaire côté client pour l'affichage optimiste. */
function buildTempMission(
  input: CreateMissionInput,
  buyerId: string,
  now: number,
): MissionDTO {
  const isoNow = new Date(now).toISOString();
  return {
    id: '', // Sera remplacé par addOptimisticCreate qui génère tmp_*
    buyerId,
    travelerId: null,
    status: 'CREATED',
    targetProduct: input.targetProduct,
    budgetCents: input.budgetCents,
    commissionCents: input.commissionCents,
    origin: input.origin,
    destination: input.destination,
    substitutionAuthorized: input.substitutionAuthorized ?? false,
    deliveryProofStatus: 'PENDING',
    version: 0,
    expiresAt: input.expiresAt,
    createdAt: isoNow,
    updatedAt: isoNow,
  };
}

export interface UseCreateMissionResult {
  readonly create: (input: CreateMissionInput) => Promise<MissionDTO | null>;
  readonly isLoading: boolean;
}

export function useCreateMission(): UseCreateMissionResult {
  const [isLoading, setIsLoading] = useState(false);
  const showToast = useToastStore((s) => s.showToast);
  const buyerId = useAuthStore((s) => s.session?.user.id ?? '');

  const create = useCallback(
    async (input: CreateMissionInput): Promise<MissionDTO | null> => {
      setIsLoading(true);
      try {
        const now = Date.now();
        const tempMission = buildTempMission(input, buyerId, now);

        const outcome = await withOptimisticCreate(useMissionStore, {
          tempMission,
          request: () => createMissionApi(input),
          now: () => Date.now(),
        });

        if (outcome.status === 'failed') {
          showToast(`Échec de création (${outcome.error.code}).`, 'error');
          return null;
        }

        return outcome.mission;
      } finally {
        setIsLoading(false);
      }
    },
    [buyerId, showToast],
  );

  return { create, isLoading };
}
