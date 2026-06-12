# Workflow — Matchmaking

> Appariement d'une mission avec un runner disponible. PostgreSQL + Prisma, zéro chat.

## Principe
- Le matchmaking est **côté serveur, déterministe et traçable** : score calculé en SQL/Prisma,
  pas de négociation libre entre parties (règle zéro chat).
- Une mission a au plus **un runner actif** à la fois.

## États
```
MISSION_CREATED → MATCHING → MATCH_PROPOSED → MATCH_ACCEPTED → IN_PROGRESS
                     ↓              ↓ (timeout/refus)
                NO_RUNNER      MATCHING (retour file, runner suivant)
```
- `failureReason` obligatoire sur `NO_RUNNER`.
- Timeout d'acceptation runner = retour en `MATCHING`, jamais d'auto-accept (validation humaine).

## Règles
1. Sélection candidats : disponibilité déclarée + zone géo + historique fiabilité.
2. Proposition envoyée à **un seul runner à la fois** (pas de course à l'acceptation —
   évite le TOCTOU d'attribution).
3. Acceptation = `UPDATE ... WHERE status = 'MATCH_PROPOSED' AND runnerId = :id` atomique ;
   rowcount 0 → proposition expirée, répondre `MATCH_EXPIRED`.
4. À `MATCH_ACCEPTED` : plafond de mission figé en centimes (Int) en DB —
   c'est cette valeur que lit le webhook JIT (cf. `gotchas.md`).
5. Carte Issuing (Option B JIT) activée pour le runner **seulement** à `IN_PROGRESS`,
   désactivée à la clôture ou à l'annulation.

## Interdits
- Chat ou champ libre entre client et runner.
- Attribution multiple simultanée.
- Pré-financement de la carte (Option B = JIT strict).
