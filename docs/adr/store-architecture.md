# ADR — Architecture du store Mission (Zustand)

> Statut : **adopté** (2026-06-25)
> Contexte : ARCH-STORE-00 — conception de la shape du store Zustand pour le slice Mission (mobile Waylo).

---

## 1. Problème

L'app mobile doit :

1. Être **consultable hors-ligne** (données en cache au boot).
2. Supporter des **mutations optimistes** (l'UI avance avant l'ACK serveur).
3. Gérer les **conflits de version** (409 `VERSION_CONFLICT` du backend, cf. SHARED-409).
4. **Rollback** automatiquement en cas d'échec réseau ou de conflit.
5. **Persister** les données confirmées de façon chiffrée (expo-secure-store).

Le store doit concilier ces cinq contraintes avec un état atomique et prévisible.

---

## 2. Décisions

### Décision 1 — Entités normalisées avec `_meta` par-entité ET par-collection

Chaque mission stockée est un `MissionEntity` :

```
MissionEntity = { data: MissionDTO, _meta: EntityMeta }
```

`EntityMeta` porte trois champs :

| Champ | Type | Rôle |
|---|---|---|
| `lastSyncedAt` | `number \| null` | ms epoch du dernier ACK 200. `null` = jamais synchronisé (boot cache). N'avance **jamais** sur un optimisme ni un 409. |
| `source` | `'network' \| 'cache' \| 'optimistic'` | Provenance de la donnée. Pilote l'indicateur de fraîcheur en UI et les gardes de persistance. |
| `stale` | `boolean` | `true` après un 409 ou un `failMutation` (réseau/5xx). Le refetch est requis mais la donnée reste consultable. |

La collection elle-même porte un `_meta` de même forme (fraîcheur du dernier `GET /missions`).

**Justification** : la fraîcheur par-entité permet de distinguer une mission reçue via un ACK 200 d'une mission uniquement servie depuis le cache, et de marquer individuellement les entités en conflit.

### Décision 2 — Snapshot embarqué pour rollback O(1)

Chaque `PendingMutation` embarque **sa propre pré-image** :

```
Snapshot<T> = { entity: T, baseVersion: number, capturedAt: number }
```

Le rollback consiste à restaurer `snapshot.entity` dans le store — **aucune relecture** de l'état courant (qui a été muté par l'optimisme), **aucun rejeu** de l'historique.

**Invariant** : au plus **une** mutation `inflight` par `missionId` (sérialisation par entité). Cela garantit que le snapshot est toujours exact : pas de pré-images empilées, pas d'ordre à respecter.

**Complexité** : O(1) par rollback. Pas de file de mutations à rejouer.

### Décision 3 — Gestion de la désynchronisation (409 Conflict)

Séquence lors d'un 409 `VERSION_CONFLICT` :

1. `rollbackOnConflict(mutationId, conflict)` est appelé.
2. La pré-image est restaurée (`snapshot.entity.data`).
3. La donnée est marquée `stale: true` si `conflict.details.currentVersion > snapshot.baseVersion` (le serveur a avancé).
4. La `PendingMutation` est retirée.
5. Le `ConflictPayload` est remonté à l'appelant (`{ status: 'conflict', conflict }`).
6. L'appelant (hook) affiche un toast et déclenche un refetch.

**Règle capitale** : on ne **fabrique jamais** la version absente. La donnée restaurée reste à `baseVersion`. Un retry naïf re-déclencherait un 409 — côté sûr — jusqu'au refetch qui ramènera `currentVersion` depuis le serveur.

### Décision 4 — Séparation persistance SecureStore vs mémoire volatile

| Donnée | Destination | Raison |
|---|---|---|
| Missions confirmées (`source: 'network'` ou `'cache'`) | SecureStore (clé `waylo.missions.v1`) | Lecture offline au boot |
| `_pendingMutations` | **Mémoire volatile uniquement** | Une mutation non acquittée ne doit pas survivre à un redémarrage — le serveur n'a rien confirmé |
| Missions `source: 'optimistic'` (création en vol) | **Mémoire volatile uniquement** | Pas d'ID serveur — impossible de réconcilier après un crash |
| Pré-images de mutations en vol | **Persistées via substitution** : pour une mission avec mutation `inflight`, on persiste la pré-image (snapshot.entity), pas l'état optimiste | Cohérence : le cache ne contient que des données confirmées |

Format persisté (`PersistedMissionCache`) :

```
{ missions: MissionEntity[], _meta: EntityMeta, schemaVersion: 1 }
```

Borné à `MAX_PERSISTED_MISSIONS` (50) entités triées par `updatedAt` décroissant — respect de la limite ~2 KB/item SecureStore iOS.

Le `schemaVersion` sert de poison-pill : si le cache au boot porte une version inconnue, il est purgé (pas de migration — la donnée est recréée au prochain fetch).

### Décision 5 — État atomique (set() unique par transition)

Chaque action du store met à jour `missions`, `_pendingMutations` et `_meta` dans un **seul appel `set()`**. Aucun état intermédiaire n'est visible par les composants entre deux frames React.

Exemples :
- `beginMutation` : insère la `PendingMutation` ET remplace l'entité par sa version optimiste — dans le même `set()`.
- `commitMutation` : remplace l'entité par la réponse serveur ET retire la `PendingMutation` — dans le même `set()`.
- `rollbackOnConflict` : restaure la pré-image ET retire la `PendingMutation` — dans le même `set()`.

### Décision 6 — Temps injecté (déterminisme)

Toutes les actions qui impliquent un horodatage reçoivent un paramètre `at: number` (ms epoch). Le store n'appelle **jamais** `Date.now()` en interne. Les tests sont déterministes sans mock d'horloge.

### Décision 7 — Rollback offline

Quand une mutation échoue par **absence de réseau** (réseau / 5xx), le serveur n'a ni confirmé ni rejeté l'écriture. Le comportement est :

1. `failMutation(id)` restaure la pré-image (snapshot).
2. L'entité est marquée `stale: true` — la donnée locale n'est **pas garantie** à jour.
3. Le refetch n'est pas déclenché immédiatement (le réseau est absent).
4. Au retour en ligne, le prochain refetch ramènera les données fraîches et remettra `stale: false`.

Distinction avec le 409 : un 409 est un **rejet actif** (le serveur connaît l'état) ; un échec réseau est un **non-réponse** (incertitude totale). L'issue retournée à l'appelant est différente (`conflict` vs `failed`), ce qui permet au hook de déclencher des comportements distincts (toast conflit vs toast erreur réseau).

### Décision 8 — Création optimiste (pas de version, pas de 409)

Une **création** de mission n'a pas de `baseVersion` (ressource inexistante) et ne peut pas recevoir de 409. Le cycle est plus simple :

1. `addOptimisticCreate(mission, at)` : insère avec un ID temporaire (`tmp_${crypto.randomUUID()}`), `source: 'optimistic'`.
2. Succès : `commitCreate(tempId, serverMission, at)` — retire le tmp, insère l'ID serveur.
3. Échec : `abortCreate(tempId)` — retire le tmp sans trace.

Les créations `optimistic` sont **filtrées** de la persistance (`toPersistedCache` exclut `source === 'optimistic'`).

---

## 3. Alternatives écartées

| Alternative | Raison du rejet |
|---|---|
| **Rejeu d'un log de mutations** au lieu des snapshots | Complexité O(n) au rollback, ordre sensible, pré-images implicites — fragile pour le nombre réduit de mutations concurrentes dans Waylo (≤ 1 par mission) |
| **Persistance des mutations en vol** | Le serveur n'a rien confirmé — les persister crée un risque de désynchronisation silencieuse après un crash-restart |
| **AsyncStorage** au lieu de SecureStore | Les données de mission (produit, budget, destination) sont confidentielles — AsyncStorage est en clair sur disque |
| **Version fabriquée après un 409** | Dangereux : le client prétendrait connaître `currentVersion` sans l'avoir reçue d'un GET — un retry réussirait par accident et masquerait le conflit |

---

## 4. Conséquences

- Les types (`mission.store.types.ts`) sont la **source de vérité** de la forme du store. Toute modification structurelle commence ici.
- Le store est testable sans I/O : SecureStore est injecté via le module `mission-cache.ts`, mockable en test.
- Le temps est déterministe : `at: number` partout, pas de `Date.now()` interne.
- L'invariant « ≤ 1 mutation inflight par mission » est vérifié par `beginMutation` (throw `MUTATION_IN_FLIGHT`).
- Le cache SecureStore est auto-réparant : schéma inconnu → purge, corruption JSON → purge.
