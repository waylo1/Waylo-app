# ADR 0001 — Architecture du store Mission (Zustand) : optimistic updates + lecture offline

- **Statut** : Accepté (conception — aucune implémentation de logique dans cette tâche, cf. [ARCH-STORE-00])
- **Date** : 2026-06-25
- **Portée** : `packages/mobile` — slice Mission du store Zustand
- **Types associés** : [`src/missions/mission.store.types.ts`](../../src/missions/mission.store.types.ts)

---

## Contexte

L'app mobile (Expo) gère son état avec un **store Zustand maison** — pas de React Query,
donc le cache, la fraîcheur, l'optimisme et le rollback sont à notre charge explicite.

Deux exigences nouvelles :

1. **Optimistic updates avec rollback propre.** L'UI doit refléter immédiatement une
   action (`/validate`, `/confirm-receipt`) sans attendre l'aller-retour réseau, puis
   se réconcilier — y compris **annuler proprement** si le serveur refuse.
2. **Lecture offline avec fraîcheur.** L'utilisateur doit pouvoir consulter ses missions
   hors-ligne, avec un indicateur de fraîcheur (`lastSyncedAt`, provenance réseau/cache).

Contrainte structurante côté backend : depuis **[SHARED-409]**, `Mission` porte un
`version Int` et les transitions acheteur sont protégées par **verrouillage optimiste**.
Une mutation envoie `expectedVersion` ; si le serveur a bougé, il répond **`409` +
`ConflictPayload { error, details: { currentVersion, expectedVersion } }`**.
Le store DOIT savoir transformer ce 409 en rollback + resynchronisation.

L'architecture existante donne le cadre (cf. [`auth/auth.store.ts`](../../src/auth/auth.store.ts),
[`auth/secure-store.ts`](../../src/auth/secure-store.ts)) :

- **Deux couches** : `SecureStore` (persistance chiffrée) + Zustand (état mémoire).
- **Persistance = SecureStore uniquement.** AsyncStorage est **interdit** (clair sur
  disque) ; limite ~2 KB par item sur iOS (Keychain).
- **Philosophie optimiste (MOB-06)** : on ne punit pas l'utilisateur du silence du
  serveur (réseau / 5xx) ; seul un **rejet ACTIF** (401, et désormais 409) change l'état.

---

## Décision 1 — Structure de rollback : `_pendingMutations` **avec snapshot embarqué** (hybride)

Trois options ont été pesées :

| Option | Idée | Verdict |
|---|---|---|
| **A. `_snapshots` seuls** | Empiler des copies de l'état (slice ou entité) avant chaque mutation ; restaurer au rollback. | Simple mais grossier : un snapshot pris avant la mutation B contient déjà l'optimisme de A ; l'ordre de rollback devient piégeux, et rien ne corrèle un snapshot à une requête / une `version`. |
| **B. `_pendingMutations` seules (journal)** | File de commandes ; l'état affiché = base confirmée + rejeu des mutations. Rollback = retirer la commande et rejouer. | Le plus puissant (réordonnancement, file offline durable) mais demande un moteur de rejeu pur + une « base confirmée » séparée. Surdimensionné pour le périmètre actuel (écritures en ligne + lecture offline, **pas** de file d'écritures offline durable). |
| **C. Hybride (retenue)** | Un registre `_pendingMutations` indexé par `MutationId`, où **chaque mutation embarque SA pré-image** (`Snapshot`) de l'entité touchée + la `baseVersion`. | Rollback **local, exact, O(1)** : restaurer l'entité depuis son snapshot, retirer la mutation. La `snapshot.baseVersion` se corrèle directement au `ConflictPayload.expectedVersion`. Extensible vers un journal complet (option B) plus tard. |

**On retient C.** Une mutation optimiste = un enregistrement `PendingMutation` qui porte :
son `id` (généré client), le `missionId`, le `kind` (union fermée `VALIDATE | CONFIRM_RECEIPT`),
l'`expectedVersion` envoyé, et **le `Snapshot` de l'entité avant mutation**.

**Invariant clé : au plus UNE mutation `inflight` par `missionId`** (sérialisation par
entité). Ce verrou rend le rollback par snapshot toujours exact : pas de pré-images
empilées sur la même mission, donc pas d'ambiguïté d'ordre. Une 2ᵉ action sur une mission
déjà en vol est refusée côté store (pas de logique ici — règle énoncée pour
l'implémentation ARCH-STORE-01+).

Le `Snapshot` est volontairement **générique** (`Snapshot<T>`) : c'est de l'infrastructure
réutilisable pour toute entité versionnée, pas un type couplé à Mission.

---

## Décision 2 — Règles de gestion du `_meta` (fraîcheur)

`_meta` répond à « cette donnée est-elle fraîche, et d'où vient-elle ? ». Il existe à
**deux niveaux**, complémentaires :

- **Par entité** (`MissionEntity._meta`) : fraîcheur d'UNE mission (badge « synchronisé
  il y a 2 h » sur l'écran détail, état stale après conflit).
- **Au niveau collection** (`MissionSliceState._meta`) : fraîcheur du dernier
  `GET /missions` (pilote le pull-to-refresh et l'écran liste offline).

Champs et règles (`EntityMeta`) :

| Champ | Type | Règle de transition |
|---|---|---|
| `lastSyncedAt` | `number \| null` | ms epoch du **dernier ACK réseau confirmé** (200). `null` = jamais synchronisé (servi depuis cache au boot). N'avance **que** sur une donnée serveur confirmée — **jamais** sur une mutation optimiste (qui n'est pas confirmée) ni sur un 409 (on n'a pas la donnée fraîche, seulement un numéro de version). |
| `source` | `'network' \| 'cache'` | `'network'` après un ACK serveur ; `'cache'` quand l'entité est rehydratée depuis SecureStore au boot, avant tout appel réseau. |
| `stale` | `boolean` | `true` après un **409** ou une invalidation : la donnée locale n'est plus garantie à jour → un refetch est requis. **N'efface pas** la donnée (la lecture offline reste possible, juste signalée périmée). Repasse `false` au prochain ACK 200. |

Le **temps est injecté** (`at: number` passé aux actions), jamais lu via `Date.now()`
dans le store — déterminisme et testabilité (cf. contrainte connue des scripts/tests).

---

## Décision 3 — Comportement sur `409` (version mismatch)

Séquence, en **une seule transition atomique** (`set()` unique, cf. Décision 5) :

1. **Localiser** la `PendingMutation` par son `MutationId` (corrélée à la requête).
2. **Rollback** : remplacer l'entité par `pendingMutation.snapshot.entity` (la pré-image
   capturée avant l'optimisme). L'état revient EXACTEMENT à `baseVersion`.
3. **Appliquer le `ConflictPayload`** : `details.currentVersion > details.expectedVersion`
   prouve que le serveur a avancé. On **ne fabrique pas** de donnée qu'on n'a pas — on
   **ne bump pas** `version` vers `currentVersion` (sinon un retry enverrait
   `expectedVersion = currentVersion` sur une donnée locale périmée → corruption). À la
   place : `entity._meta.stale = true`. Le delta de version est la **preuve** qu'un
   refetch autoritaire (`GET /missions/:id`) est nécessaire ; ce refetch ramènera la
   donnée À `currentVersion` (ou au-delà) et repassera `stale = false`, `source = 'network'`.
4. **Retirer** la `PendingMutation` du registre (le snapshot est jeté avec elle).
5. **Surface UI** (logique différée) : `stale = true` + le `currentVersion` connu
   permettent d'afficher « cette mission a changé ailleurs, on rafraîchit ».

> En résumé : le `ConflictPayload` ne réécrit pas l'état avec des données absentes ; il
> **déclenche** rollback + passage en `stale` + refetch. C'est l'extension naturelle de
> l'optimisme MOB-06 : un **rejet actif** (ici 409) défait l'optimisme, proprement.

**Distinction des échecs** (action `failMutation` vs `rollbackOnConflict`) :

- **409 (rejet actif de version)** → `rollbackOnConflict` : rollback **toujours**.
- **Réseau / 5xx (silence serveur)** → `failMutation` : conforme à MOB-06, on **ne
  rollback pas par réflexe**. La mutation peut rester `inflight` pour retry (le serveur
  n'a pas statué). La politique exacte (retry/backoff) est différée.
- **200** → `commitMutation` : l'entité est remplacée par la réponse serveur (nouvelle
  `version`), `lastSyncedAt`/`source` avancent, la mutation est retirée.

---

## Décision 4 — Persistance : SecureStore (confirmé) **vs** mémoire volatile (optimiste)

Règle d'or : **seul l'état confirmé par le serveur est persisté ; tout l'état optimiste /
en vol est volatile.**

| Donnée | Emplacement | Pourquoi |
|---|---|---|
| Token / session (`waylo.session.v1`) | **SecureStore** (existant) | Secret. |
| Cache missions confirmées + `_meta` (`waylo.missions.v1`, type `PersistedMissionCache`) | **SecureStore** | Permet la **lecture offline**. Chiffré au repos (Keychain/Keystore) — aligné RGPD (donnée personnelle) et avec l'interdiction d'AsyncStorage (clair sur disque). |
| `_pendingMutations` + leurs `Snapshot` | **Mémoire volatile** | État optimiste **non confirmé**. À un cold start, les mutations en vol sont **abandonnées**, pas rejouées — on resynchronise depuis le réseau. Persister une mutation risquerait de la rejouer contre une `version` serveur qui a bougé (corruption). |
| Drapeaux transitoires de sync (loading, refetch en cours) | **Mémoire volatile** | UI éphémère. |

**Limite SecureStore (~2 KB/item iOS) — risque assumé.** Une liste de missions peut
dépasser cette borne. Mesures de conception :

- `PersistedMissionCache` est **borné** (top-N missions actives, projection compacte) et
  porte un `schemaVersion` (migration / poison-pill : un cache illisible est purgé au
  boot, comme `readSession` le fait déjà pour la session).
- Le cache persisté ne stocke **jamais** `_pendingMutations` (volatile par conception),
  ce qui borne naturellement sa taille à l'état confirmé.
- **Évolution** (hors périmètre) : si le cache confirmé dépasse durablement la limite, on
  migre **la couche cache** (pas les secrets) vers un stockage chiffré dédié — **jamais**
  vers AsyncStorage en clair. Cette bascule ne toucherait pas la frontière de cette ADR
  (confirmé persisté / optimiste volatile).

---

## Décision 5 — Pattern d'état atomique

Chaque transition (`syncMissions`, `beginMutation`, `commitMutation`,
`rollbackOnConflict`, `failMutation`) est un **`set()` unique** qui met à jour ensemble
`missions`, `_pendingMutations` et `_meta`. Aucun état intermédiaire incohérent n'est
jamais visible (p. ex. une entité rollback sans que sa `PendingMutation` soit retirée).
Les structures sont typées `Readonly` / `readonly` pour forcer le remplacement immuable
plutôt que la mutation en place.

---

## Conséquences

**Positives**
- Rollback exact et bon marché ; corrélation directe 409 ↔ mutation via la version.
- Lecture offline avec fraîcheur explicite, chiffrée au repos.
- Frontière persistance nette et défendable (confirmé vs optimiste) ; cohérente avec
  l'existant (SecureStore-only, optimisme MOB-06).
- Types stricts, `Snapshot` réutilisable, union de mutations fermée (exhaustivité forcée).

**Négatives / à surveiller**
- Limite ~2 KB SecureStore → cache borné, risque de migration future de la couche cache.
- L'invariant « ≤ 1 mutation en vol par mission » simplifie le rollback mais interdit le
  pipelining de plusieurs actions sur la même mission (acceptable pour le périmètre).
- Pas de file d'écritures **offline durable** (volontaire) : une action lancée hors-ligne
  n'est pas rejouée après redémarrage — elle échoue côté UI et sera relancée par
  l'utilisateur. Une future ADR pourra promouvoir `_pendingMutations` en journal persistant
  (option B) si le besoin d'offline-write apparaît.

**Hors périmètre de cette tâche** : toute implémentation de logique (reducers, appels API,
politique de retry, refetch). Cette ADR + les types associés fixent uniquement la *forme*.
