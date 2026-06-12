# Workflow — Substitution

> Article indisponible en magasin → proposition de remplacement. Zéro chat, validation humaine obligatoire.

## Principe
- Le runner ne décide **jamais** seul. Toute substitution est proposée via des
  **choix structurés** et validée explicitement par le client.
- Pas de champ texte libre : photo + référence produit + écart de prix en centimes.

## États
```
ITEM_UNAVAILABLE → SUBSTITUTION_PROPOSED → SUBSTITUTION_ACCEPTED → (achat autorisé)
                          ↓ (refus client)        
                   SUBSTITUTION_REJECTED → ITEM_SKIPPED (remboursement ligne)
                          ↓ (timeout)
                   ITEM_SKIPPED (jamais d'auto-accept)
```

## Règles
1. Proposition runner = payload structuré : `{ originalItemId, substituteRef, photoSha256, priceDeltaCents }`.
   La photo du substitut est obligatoire (sha256 vérifié serveur, comme les listings).
2. Le client répond par **boutons** : Accepter / Refuser / Refuser et ignorer l'article.
   Aucune contre-proposition libre — si le substitut ne convient pas, l'article est ignoré.
3. `priceDeltaCents > 0` : re-vérifier le plafond de mission **dans la même transaction**
   que l'acceptation (anti-TOCTOU) avant de relever le plafond lu par le webhook JIT.
4. Timeout client (réseau magasin lent côté runner ≠ silence client — cf. `gotchas.md`) :
   l'article passe en `ITEM_SKIPPED`, jamais accepté implicitement.
5. Tout `ITEM_SKIPPED` déclenche le recalcul du plafond JIT à la baisse + remboursement
   wallet de la ligne en `prisma.$transaction()`.

## Interdits
- Auto-acceptation (timeout, "le client répond pas", heuristique IA).
- Substitution sans photo scellée.
- Modification du plafond JIT hors transaction atomique.
