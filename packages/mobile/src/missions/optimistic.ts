// withOptimisticUpdate — cœur de l'optimisme + rollback hybride O(1).
//
// Orchestration d'une mutation versionnée (cf. ARCH-STORE-00 / ADR 0001) :
//   1. begin  : capture un snapshot + applique l'update optimiste (state.beginMutation) ;
//   2. request: appelle le backend avec l'`expectedVersion` figé au begin ;
//   3. réconciliation de l'ACK serveur :
//        - 200            → commitMutation (remplace par la réponse, version serveur) ;
//        - 409 CONFLICT   → rollbackOnConflict (restaure la pré-image, marque stale) ;
//        - réseau / 5xx   → failMutation (défait l'optimisme, marque stale).
//
// L'appel réseau (`request`) est INJECTÉ : aucune route codée en dur ici (testable,
// pas d'invention d'endpoint). Le temps est injecté (`now`).

import type { ConflictPayload, MissionDTO } from '@waylo/shared';
import { type ApiError, toApiError } from '../api/errors';
import { MissionStoreError } from './mission.store';
import type { MissionId, MissionSlice, MutationId, PendingMutationKind } from './mission.store.types';

/** Issue d'une tentative optimiste — discriminée, exhaustive côté appelant. */
export type OptimisticOutcome =
  | { readonly status: 'committed'; readonly mission: MissionDTO }
  | { readonly status: 'conflict'; readonly conflict: ConflictPayload }
  | { readonly status: 'failed'; readonly error: ApiError }
  | { readonly status: 'rejected'; readonly reason: 'MISSION_UNKNOWN' | 'MUTATION_IN_FLIGHT' };

/** Accès minimal au store (le hook Zustand le satisfait : `useMissionStore`). */
interface OptimisticStore {
  getState: () => MissionSlice;
}

export interface WithOptimisticParams {
  readonly missionId: MissionId;
  readonly kind: PendingMutationKind;
  /** Appel backend ; reçoit l'`expectedVersion` figé au début de la mutation. */
  readonly request: (expectedVersion: number) => Promise<MissionDTO>;
  /** Horloge injectée (ms epoch) — jamais `Date.now()` interne. */
  readonly now: () => number;
}

/** Garde de forme du `details` d'un 409 VERSION_CONFLICT (sans `any`). */
function isConflictDetails(d: unknown): d is { currentVersion: number; expectedVersion: number } {
  if (typeof d !== 'object' || d === null) {
    return false;
  }
  const r = d as Record<string, unknown>;
  return typeof r.currentVersion === 'number' && typeof r.expectedVersion === 'number';
}

/** Reconstruit un `ConflictPayload` typé depuis l'`ApiError`, ou `null` si non-conflit. */
function asConflictPayload(err: ApiError): ConflictPayload | null {
  if (err.status === 409 && err.code === 'VERSION_CONFLICT' && isConflictDetails(err.details)) {
    return {
      error: 'VERSION_CONFLICT',
      details: {
        currentVersion: err.details.currentVersion,
        expectedVersion: err.details.expectedVersion,
      },
    };
  }
  return null;
}

/** Persistance best-effort : un échec SecureStore ne doit pas faire échouer la mutation. */
async function persistQuietly(store: OptimisticStore): Promise<void> {
  try {
    await store.getState().persist();
  } catch {
    // Volontairement silencieux (cf. ADR : persistance = confort offline, pas critique).
  }
}

// ── Création optimiste ────────────────────────────────────────────────────────

/** Issue d'une création optimiste — plus simple que l'update (pas de 409 sur une création). */
export type OptimisticCreateOutcome =
  | { readonly status: 'committed'; readonly mission: MissionDTO }
  | { readonly status: 'failed'; readonly error: ApiError };

export interface WithOptimisticCreateParams {
  /** Mission pré-construite avec un ID temporaire (`tmp_*`). */
  readonly tempMission: MissionDTO;
  /** Appel backend POST /api/missions (sans version : nouvelle ressource). */
  readonly request: () => Promise<MissionDTO>;
  /** Horloge injectée (ms epoch). */
  readonly now: () => number;
}

export async function withOptimisticCreate(
  store: OptimisticStore,
  params: WithOptimisticCreateParams,
): Promise<OptimisticCreateOutcome> {
  const { tempMission, request, now } = params;

  const tempId = store.getState().addOptimisticCreate(tempMission, now());

  try {
    const serverMission = await request();
    store.getState().commitCreate(tempId, serverMission, now());
    await persistQuietly(store);
    return { status: 'committed', mission: serverMission };
  } catch (err) {
    store.getState().abortCreate(tempId);
    return { status: 'failed', error: toApiError(err) };
  }
}

// ── Update optimiste ──────────────────────────────────────────────────────────

export async function withOptimisticUpdate(
  store: OptimisticStore,
  params: WithOptimisticParams,
): Promise<OptimisticOutcome> {
  const { missionId, kind, request, now } = params;

  const entity = store.getState().missions[missionId];
  if (entity === undefined) {
    return { status: 'rejected', reason: 'MISSION_UNKNOWN' };
  }
  // `expectedVersion` figé AVANT l'optimisme (la pré-image est à cette version).
  const expectedVersion = entity.data.version;

  let mutationId: MutationId;
  try {
    mutationId = store.getState().beginMutation(missionId, kind, now());
  } catch (err) {
    if (err instanceof MissionStoreError && err.code === 'MUTATION_IN_FLIGHT') {
      return { status: 'rejected', reason: 'MUTATION_IN_FLIGHT' };
    }
    if (err instanceof MissionStoreError && err.code === 'MISSION_UNKNOWN') {
      return { status: 'rejected', reason: 'MISSION_UNKNOWN' };
    }
    throw err;
  }

  try {
    const result = await request(expectedVersion);
    store.getState().commitMutation(mutationId, result, now());
    await persistQuietly(store);
    return { status: 'committed', mission: result };
  } catch (err) {
    const apiError = toApiError(err);
    const conflict = asConflictPayload(apiError);
    if (conflict !== null) {
      store.getState().rollbackOnConflict(mutationId, conflict);
      return { status: 'conflict', conflict };
    }
    store.getState().failMutation(mutationId);
    return { status: 'failed', error: apiError };
  }
}
