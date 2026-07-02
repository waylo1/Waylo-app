# AUDIT-00 — Remédiation des constats orphelins

Trois constats de l'audit-00 restent en backlog (`docs/ROADMAP_VISUAL.html`, colonne
« À faire / Bloqué »). Ce document fixe le rôle, le fichier cible et le risque de
chacun pour que la prochaine intervention soit chirurgicale.

### Whitelist DTO

- **ID** : `AUDIT-00-DTO`
- **Rôle** : filtrer les réponses API par liste blanche explicite de champs plutôt
  que par retrait (blacklist) de champs sensibles.
- **Fichier cible** : `src/dto/`
- **Risque** : une sérialisation par blacklist oublie de retirer un champ sensible
  ajouté ultérieurement au modèle (ex. `passwordHash`, `token`) → fuite d'information
  par défaut à chaque nouvelle colonne, au lieu d'un refus par défaut.

### Clés Idempotence

- **ID** : `AUDIT-00-IDEM`
- **Statut** : **Terminée/Vérifiée** — PR [#54](https://github.com/waylo1/Waylo-app/pull/54),
  branche `fix/audit-00-idem-unify`, 377/377 tests verts.
- **Rôle** : unifier le format des clés d'idempotence sur les chemins de capture
  pour garantir une déduplication fiable.
- **Fichier cible** : `src/services/escrow.service.ts`
- **Risque** : des formats de clé divergents entre chemins de capture empêchent la
  détection d'un rejeu (retry Stripe, double webhook) → double paiement ou double
  capture sur une même mission.
- **Remédiation appliquée** : nouveau format `waylo:<missionId>:cap:<context>:v1`
  (`context` ∈ `validate`/`receipt`/`receive`/`collection`/`customs`/`payout`/`timeout`).
  `captureEscrowFunds` est désormais le SEUL point d'appel Stripe
  `paymentIntents.capture` du projet — les 3 appels directs restants
  (`customs-approve`, `admin/resolve-payout`, timeout collecte du worker de
  réconciliation) sont centralisés dedans, avec montant explicite
  (`heldBudgetCents + commission`) au lieu d'une capture "tout le PI".

#### AUDIT-00-IDEM : changements de comportement

- **`/validate` vs `/confirm-receipt` — fin de la déduplication silencieuse
  croisée.** Avant cette remédiation, ces deux routes partageaient la même clé
  d'idempotence (`capture_<missionId>`) : un acheteur déclenchant les deux
  routes sur la même mission (double-clic, retry client, course avec un autre
  onglet) voyait Stripe **dédupliquer silencieusement** le second appel — même
  réponse renvoyée, aucune erreur.
  Depuis cette PR, `/validate` utilise le contexte `validate` et
  `/confirm-receipt` le contexte `receipt` → **deux clés distinctes**. Le
  second appel sur la même mission n'est plus dédupliqué par la clé : il
  atteint Stripe avec une clé neuve sur un PaymentIntent déjà capturé, et
  Stripe **refuse explicitement** cette capture (erreur, propagée en 500 côté
  API si elle n'est pas interceptée en amont par une garde de statut mission).
  - **Pourquoi ce n'est pas un risque financier** : aucun double débit n'est
    possible — Stripe refuse par construction toute capture sur un
    PaymentIntent déjà capturé, quelle que soit la clé fournie. La garde
    `EscrowStatus.HELD` dans `captureEscrowFunds` (lecture avant capture) est
    la protection métier réelle contre le double débit inter-chemins ; elle
    est inchangée.
  - **Ce qui change concrètement** : le *mode d'échec* du second appel. Avant :
    succès silencieux (réponse Stripe mise en cache rejouée). Après : erreur
    Stripe explicite si le second appel a lieu **après** que le premier a déjà
    fait passer l'escrow hors `HELD` en base (webhook traité) — dans ce cas la
    garde `EscrowStatus.HELD` intercepte avant même d'atteindre Stripe et
    renvoie `ESCROW_NOT_HELD` (400), comportement déjà en place et inchangé.
    Le cas résiduel (deux appels vraiment concurrents, avant que le webhook
    n'ait mis à jour l'escrow) est couvert par le test d'idempotence ajouté
    dans `capture-amount.test.ts` (2 appels concurrents même contexte → le 2e
    échoue côté Stripe, aucun impact DB).
  - **Action de suivi éventuelle** (non bloquante, hors périmètre de cette PR) :
    si ce changement de mode d'échec s'avère gênant en usage réel (erreur 500
    au lieu d'un succès silencieux pour un double-clic utilisateur), envisager
    un mapping d'erreur dédié côté route `/confirm-receipt` plutôt qu'un retour
    au partage de clé.

### Conversion Douane

- **ID** : `AUDIT-00-DOUANE`
- **Rôle** : corriger un bug d'unité dans la conversion du seuil douane.
- **Fichier cible** : `src/utils/conversion.ts`
- **Risque** : une comparaison entre un montant en centimes (Int) et un seuil
  exprimé en unité majeure (euros) fausse le déclenchement du contrôle douanier →
  perte financière (contrôle non déclenché à tort, ou déclenché à tort).
