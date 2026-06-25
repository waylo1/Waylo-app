// useValidateMission — hook acheteur pour valider une mission avec optimistic update.
//
// 200 committed → UI à jour instantanément (commit du store).
// 409 conflict  → rollback + stale + toast "Version en conflit".
// réseau / 5xx  → rollback + stale + toast d'erreur.
// rejected      → toast avertissant que la mission n'est pas disponible.

import { useCallback, useState } from 'react';
import { useMissionStore } from './mission.store';
import { withOptimisticUpdate, type OptimisticOutcome } from './optimistic';
import type { MissionId } from './mission.store.types';
import { validateMission as validateMissionApi } from '../api/missions.api';
import { useToastStore } from '../feedback/toast.store';

export interface UseValidateMissionResult {
  readonly validate: () => Promise<OptimisticOutcome>;
  readonly isLoading: boolean;
}

export function useValidateMission(missionId: MissionId): UseValidateMissionResult {
  const [isLoading, setIsLoading] = useState(false);
  const showToast = useToastStore((s) => s.showToast);

  const validate = useCallback(async (): Promise<OptimisticOutcome> => {
    setIsLoading(true);
    try {
      const outcome = await withOptimisticUpdate(useMissionStore, {
        missionId,
        kind: 'VALIDATE',
        request: (expectedVersion) => validateMissionApi(missionId, expectedVersion),
        now: () => Date.now(),
      });

      switch (outcome.status) {
        case 'conflict':
          showToast('Version en conflit — la mission a été rechargée.', 'info');
          break;
        case 'failed':
          showToast(`Erreur de validation (${outcome.error.code}).`, 'error');
          break;
        case 'rejected':
          showToast('Mission indisponible ou déjà en cours de modification.', 'info');
          break;
        case 'committed':
          break;
      }

      return outcome;
    } finally {
      setIsLoading(false);
    }
  }, [missionId, showToast]);

  return { validate, isLoading };
}
