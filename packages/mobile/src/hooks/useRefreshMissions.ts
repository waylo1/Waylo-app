// useRefreshMissions — pull-to-refresh robuste pour la liste de missions.
//
// Découplé du store : reçoit `syncMissions` en paramètre pour que l'écran
// puisse injecter n'importe quelle implémentation (store Zustand, mock en test).
//
// Anti-spam : un ref booléen (`inflightRef`) bloque toute invocation concurrente
// AVANT le re-render React (contrairement à l'état `isRefreshing` qui n'est
// visible qu'au prochain cycle de rendu).
//
// Erreur réseau : toast discret, données en cache conservées, app stable.

import { useCallback, useRef, useState } from 'react';
import type { MissionDTO } from '@waylo/shared';
import { listMissions } from '../api/missions.api';
import { toApiError } from '../api/errors';
import { useToastStore } from '../feedback/toast.store';

export interface UseRefreshMissionsOptions {
  /** Action store — appelée avec les données fraîches et l'horodatage de synchro. */
  readonly syncMissions: (missions: readonly MissionDTO[], at: number) => void;
}

export interface UseRefreshMissionsResult {
  /** `true` uniquement pendant un refresh (jamais pendant le loading initial). */
  readonly isRefreshing: boolean;
  /** Handler à passer à `RefreshControl.onRefresh`. Idempotent si déjà en cours. */
  readonly onRefresh: () => void;
}

export function useRefreshMissions({
  syncMissions,
}: UseRefreshMissionsOptions): UseRefreshMissionsResult {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inflightRef = useRef(false);
  const showToast = useToastStore((s) => s.showToast);

  const onRefresh = useCallback(async () => {
    // Anti-spam : ignorer si un refresh est déjà en cours.
    if (inflightRef.current) {
      return;
    }

    inflightRef.current = true;
    setIsRefreshing(true);

    try {
      const missions = await listMissions();
      syncMissions(missions, Date.now());
    } catch (err) {
      const apiError = toApiError(err);
      showToast(`Mise à jour impossible (${apiError.code}).`, 'error');
    } finally {
      inflightRef.current = false;
      setIsRefreshing(false);
    }
  }, [syncMissions, showToast]);

  return { isRefreshing, onRefresh };
}
