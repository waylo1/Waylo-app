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
- **Rôle** : unifier le format des clés d'idempotence sur les chemins de capture
  pour garantir une déduplication fiable.
- **Fichier cible** : `src/services/escrow.service.ts`
- **Risque** : des formats de clé divergents entre chemins de capture empêchent la
  détection d'un rejeu (retry Stripe, double webhook) → double paiement ou double
  capture sur une même mission.

### Conversion Douane

- **ID** : `AUDIT-00-DOUANE`
- **Rôle** : corriger un bug d'unité dans la conversion du seuil douane.
- **Fichier cible** : `src/utils/conversion.ts`
- **Risque** : une comparaison entre un montant en centimes (Int) et un seuil
  exprimé en unité majeure (euros) fausse le déclenchement du contrôle douanier →
  perte financière (contrôle non déclenché à tort, ou déclenché à tort).
