import type { MissionDTO } from '@waylo/shared';

export interface MissionCacheEntry {
  readonly missions: readonly MissionDTO[];
  readonly lastSyncedAt: number;
}

export interface MissionSliceState {
  readonly missions: readonly MissionDTO[];
  /** Epoch ms du dernier sync réseau réussi. null = jamais synchronisé. */
  readonly lastSyncedAt: number | null;
  readonly isLoadingInitial: boolean;
  readonly error: string | null;
}

export interface MissionSliceActions {
  /**
   * Appelé après un fetch réseau réussi. Persiste le cache dans SecureStore
   * en fire-and-forget (ne bloque pas le re-render).
   */
  syncMissions: (missions: readonly MissionDTO[], at: number) => void;
  /**
   * Hydrate depuis SecureStore au boot. Si un cache existe, remplit `missions`
   * et `lastSyncedAt`, puis passe `isLoadingInitial` à false — l'écran est
   * consultable hors-ligne sans attendre un appel réseau.
   */
  hydrate: () => Promise<void>;
  setLoadingInitial: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

export type MissionStore = MissionSliceState & MissionSliceActions;
