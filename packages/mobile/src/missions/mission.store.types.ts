// Types du slice Mission (store Zustand) — optimistic updates + lecture offline.
//
// CONCEPTION UNIQUEMENT (ARCH-STORE-00) : ce fichier fixe la FORME de l'état et le
// CONTRAT des actions. Aucune logique (reducers, appels API, retry, refetch) ici —
// l'implémentation est différée (ARCH-STORE-01+).
//
// Décisions justifiées dans docs/adr/0001-mission-store-architecture.md :
// - Rollback : registre `_pendingMutations` où chaque mutation embarque SA pré-image
//   (`Snapshot`) + `baseVersion`, corrélée au `ConflictPayload.expectedVersion`.
// - `_meta` : fraîcheur (lastSyncedAt / source / stale), par-entité ET par-collection.
// - 409 : rollback via snapshot + passage `stale` + refetch (jamais de version fabriquée).
// - Persistance : confirmé → SecureStore (chiffré, borné) ; optimiste en vol → volatile.
//
// Strict, zéro `any`. Structures `readonly` → remplacement immuable (état atomique).

import type { ConflictPayload, MissionDTO } from '@waylo/shared';

// ── Identifiants ─────────────────────────────────────────────────────────────

/** Id de mission — repris du type serveur (`MissionDTO.id`, cuid). */
export type MissionId = MissionDTO['id'];

/**
 * Identifiant d'une mutation optimiste — généré côté client, jamais confondu avec
 * un id serveur. Brand fantôme : zéro coût runtime, sûreté à la compilation
 * (un `string` brut n'est pas assignable à `MutationId` sans cast explicite).
 */
export type MutationId = string & { readonly __brand: 'MutationId' };

// ── Fraîcheur (_meta) ────────────────────────────────────────────────────────

/** Provenance de la donnée affichée — pilote l'indicateur de fraîcheur en UI. */
export type DataSource = 'network' | 'cache';

/**
 * Métadonnées de fraîcheur. Attachées à CHAQUE entité (fraîcheur d'une mission) ET
 * au niveau collection (fraîcheur du dernier `GET /missions`). Cf. ADR Décision 2.
 */
export interface EntityMeta {
  /**
   * ms epoch du dernier ACK réseau confirmé (200). `null` = jamais synchronisé
   * (servi depuis le cache au boot). N'avance JAMAIS sur une mutation optimiste
   * ni sur un 409 (aucune donnée fraîche reçue).
   */
  readonly lastSyncedAt: number | null;
  /** `'network'` après un ACK serveur ; `'cache'` après rehydratation SecureStore. */
  readonly source: DataSource;
  /**
   * `true` après un 409 ou une invalidation : donnée locale non garantie à jour,
   * refetch requis. N'efface PAS la donnée (lecture offline préservée). Repasse
   * `false` au prochain ACK 200.
   */
  readonly stale: boolean;
}

// ── Entité stockée ───────────────────────────────────────────────────────────

/**
 * Mission telle que stockée dans le slice : projection serveur (`MissionDTO`, qui
 * porte `version` — source unique de la version, jamais dupliquée) + fraîcheur locale.
 * `_meta` préfixé `_` : champ d'infrastructure, jamais rendu tel quel.
 */
export interface MissionEntity {
  readonly data: MissionDTO;
  readonly _meta: EntityMeta;
}

// ── Snapshot (pré-image de rollback) ─────────────────────────────────────────

/**
 * Pré-image immuable capturée AVANT une mutation optimiste, pour rollback exact.
 * Générique : réutilisable pour toute entité versionnée (infrastructure, non couplée
 * à Mission).
 */
export interface Snapshot<T> {
  /** Copie figée de l'entité avant l'application optimiste. */
  readonly entity: T;
  /**
   * Version serveur sur laquelle reposait la mutation (== `expectedVersion` envoyé).
   * Corrèle le rollback au `ConflictPayload.details.expectedVersion`.
   */
  readonly baseVersion: number;
  /** ms epoch de capture — diagnostic / purge des snapshots orphelins. */
  readonly capturedAt: number;
}

// ── Mutations en attente ─────────────────────────────────────────────────────

/**
 * Transitions acheteur versionnées (garde-fou 409, cf. SHARED-409). Union FERMÉE :
 * ajouter une transition = étendre ce type, ce qui force son traitement exhaustif
 * dans les reducers (le compilateur l'exige).
 */
export type PendingMutationKind = 'VALIDATE' | 'CONFIRM_RECEIPT';

/**
 * Cycle de vie minimal d'une mutation en attente. Pas de file durable : une mutation
 * `'failed'` est rollback puis retirée dans la MÊME transition atomique.
 */
export type PendingMutationStatus = 'inflight' | 'failed';

/**
 * Mutation optimiste en attente d'ACK serveur. Porte SA pré-image (`snapshot`) : le
 * rollback est local et exact, sans relire l'état courant (déjà muté). VOLATILE :
 * jamais persistée (cf. ADR Décision 4).
 */
export interface PendingMutation {
  readonly id: MutationId;
  readonly kind: PendingMutationKind;
  readonly missionId: MissionId;
  /** `expectedVersion` envoyé au backend (= `snapshot.baseVersion`, dupliqué pour lisibilité). */
  readonly expectedVersion: number;
  /** Pré-image pour rollback : entité Mission complète avant l'update optimiste. */
  readonly snapshot: Snapshot<MissionEntity>;
  readonly status: PendingMutationStatus;
  /** ms epoch de création (injecté, jamais lu via `Date.now()` dans le store). */
  readonly createdAt: number;
}

// ── État du slice ────────────────────────────────────────────────────────────

/**
 * État du slice Mission (mémoire Zustand). Forme ATOMIQUE : `missions`,
 * `_pendingMutations` et `_meta` sont mis à jour ENSEMBLE dans un `set()` unique par
 * transition — jamais d'état intermédiaire visible (cf. ADR Décision 5).
 */
export interface MissionSliceState {
  /** Entités (confirmées + optimistes), indexées par id. Normalisé (pas de tableau). */
  readonly missions: Readonly<Record<MissionId, MissionEntity>>;
  /**
   * Mutations optimistes en vol, indexées par `MutationId`. VOLATILE (jamais persisté).
   * Invariant : au plus UNE mutation `'inflight'` par `missionId` (sérialisation par
   * entité) → rollback par snapshot toujours exact (pas de pré-images empilées).
   */
  readonly _pendingMutations: Readonly<Record<MutationId, PendingMutation>>;
  /**
   * Fraîcheur au niveau COLLECTION (dernier `GET /missions`). Complète les `_meta`
   * par-entité : pilote pull-to-refresh global et écran liste offline.
   */
  readonly _meta: EntityMeta;
}

// ── Forme persistée (SecureStore) ────────────────────────────────────────────

/**
 * Forme persistée dans SecureStore (clé `waylo.missions.v1`). UNIQUEMENT l'état
 * confirmé : entités + fraîcheur. JAMAIS `_pendingMutations` (volatile par conception).
 * Bornée en taille (limite ~2 KB/item iOS) : top-N missions, projection compacte.
 * Cf. ADR Décision 4.
 */
export interface PersistedMissionCache {
  readonly missions: readonly MissionEntity[];
  readonly _meta: EntityMeta;
  /** Version de schéma du cache (migration / poison-pill au boot). */
  readonly schemaVersion: 1;
}

// ── Contrat des actions (signatures — implémentation différée) ───────────────

/**
 * Surface d'API visée du slice. Signatures UNIQUEMENT : aucune logique ici
 * (ARCH-STORE-00). Le temps est injecté (`at: number`) — jamais `Date.now()` interne
 * (déterminisme / testabilité). Implémentation : ARCH-STORE-01+.
 */
export interface MissionSliceActions {
  /** Insère/remplace des missions confirmées (`source: 'network'`), avance `lastSyncedAt`. */
  syncMissions: (missions: readonly MissionDTO[], at: number) => void;
  /**
   * Applique une mutation optimiste : capture un `Snapshot`, mute l'entité, enregistre
   * la `PendingMutation`. Retourne le `MutationId` pour corréler l'ACK serveur.
   */
  beginMutation: (missionId: MissionId, kind: PendingMutationKind, at: number) => MutationId;
  /**
   * ACK 200 : remplace l'entité par la réponse serveur (nouvelle `version`), avance
   * `lastSyncedAt`/`source`, retire la `PendingMutation` (et jette son snapshot).
   */
  commitMutation: (id: MutationId, result: MissionDTO, at: number) => void;
  /**
   * ACK 409 : rollback via `snapshot` + applique le `ConflictPayload` (passe `stale`,
   * planifie le refetch via le delta de version), retire la `PendingMutation`.
   */
  rollbackOnConflict: (id: MutationId, conflict: ConflictPayload) => void;
  /**
   * Échec non-versionné (réseau / 5xx) : selon l'optimisme MOB-06, ne rollback PAS par
   * réflexe — la mutation peut rester `'inflight'` pour retry (serveur n'a pas statué).
   */
  failMutation: (id: MutationId) => void;
}

/** Slice complet = état + actions (forme idiomatique Zustand). */
export type MissionSlice = MissionSliceState & MissionSliceActions;
