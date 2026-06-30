# ADR 002 — Modèle de Matching Global « Net Gain »

**Date** : 2026-06-30  
**Statut** : Accepté  
**Branche** : `feature/matching-net-gain`  
**Auteur** : Maxime (waylo1)

---

## Contexte

Les voyageurs ont besoin d'un catalogue de missions disponibles pour choisir leurs missions à réaliser. La question est : quel modèle de données utiliser pour représenter la récompense voyageur, et comment filtrer/trier le catalogue ?

---

## Décision 1 — Net Gain = `commissionCents` uniquement

**Le schéma ne porte pas de champ `travelerReward` distinct.**

La récompense du voyageur **est** la commission figée de la mission (`commissionCents`). La relation est :

```
totalChargéAcheteur = budgetCents + commissionCents
récompenseVoyageur  = commissionCents
```

`commissionCents` est figé à la création de la mission et ne change jamais. C'est la source de vérité pour le "Net Gain" du voyageur — le gain net après achat du produit au `budgetCents`.

**Pourquoi ne pas ajouter un champ `travelerRewardCents` séparé ?**
- Redondance : ce serait toujours égal à `commissionCents` (invariant).
- Risque de désynchronisation : deux champs → deux sources de vérité potentielles → bug de cohérence.
- Complexité sans valeur ajoutée.

**Conséquence** : L'API expose `travelerRewardCents` (alias lisible) mappé depuis `commissionCents` — mais en DB, un seul champ.

---

## Décision 2 — Catalogue global, zéro filtre géographique serveur

**Le serveur n'applique aucun filtre géographique.**

Le catalogue expose **toutes** les missions en statut `FUNDED`, triées par rentabilité décroissante. Le filtrage par corridor (origin/destination) est délégué entièrement au voyageur côté client.

**Pourquoi ?**
- Le voyageur est un **opérateur autonome** qui définit lui-même son corridor et évalue la faisabilité douanière.
- Waylo n'a pas de données sur les plans de voyage des voyageurs — tout filtre serveur serait arbitraire et exclurait des opportunités légitimes.
- Simplification du service : `WHERE status = FUNDED` uniquement, pas de jointure géographique complexe.
- Le filtrage client (origin/destination) est suffisant pour les volumes actuels.

**Disclaimer opérationnel** : Chaque offre retournée injecte `operationalDisclaimer` — Waylo décline explicitement toute responsabilité sur la légalité et la faisabilité du corridor choisi par le voyageur.

---

## Décision 3 — Index `idx_net_gain_matching`

**Un index composite aligné sur la requête réelle est ajouté sur `Mission`.**

```sql
CREATE INDEX "idx_net_gain_matching"
  ON "Mission"("status", "commissionCents" DESC, "createdAt" DESC);
```

**Pourquoi cet index et pas `(status, createdAt)` (existant) ?**

La requête cible :
```sql
WHERE "status" = 'FUNDED'
ORDER BY "commissionCents" DESC, "createdAt" DESC
```

L'`ORDER BY` mène sur `commissionCents`. L'index existant `(status, createdAt)` ne couvre pas ce tri — PostgreSQL serait obligé d'un tri en mémoire (`Sort` node) sur le résultat filtré. Avec `idx_net_gain_matching`, la colonne de tête du tri (`commissionCents`) est directement dans l'index après `status` → parcours index déjà ordonné, **zéro tri en RAM**.

**Impact** : Élimination du Sort node pour le catalogue matching. Critique en charge (N voyageurs simultanés consultant le catalogue).

---

## Alternatives rejetées

| Alternative | Raison du rejet |
|---|---|
| Champ `travelerRewardCents` en DB | Redondance avec `commissionCents`, risque désynchronisation |
| Filtrage géographique serveur | Arbitraire, exclut des opportunités légitimes, complexifie la DB |
| Index `(status, createdAt)` existant | Ne couvre pas l'`ORDER BY commissionCents` → Sort en RAM |
| Pas d'index dédié | Seq scan sur `Mission` en charge → inacceptable |

---

## Conséquences

- **Plafond de page** : `MATCH_PAGE_LIMIT_MAX = 100` pour borner la charge DB et la taille de réponse (anti-DoS).
- **Pagination sans `COUNT(*)`** : Pattern `limit + 1` — une ligne sentinelle calcule `hasMore` sans requête COUNT séparée.
- **Validation stricte** : `page`/`limit` doivent être des entiers dans les bornes — aucune coercition, `INVALID_PAGINATION` 400 sinon.
- **Service read-only** : `getAvailableMatches` ne modifie aucune donnée → pas de `$transaction`, pas de `AdminAuditLog` requis.
