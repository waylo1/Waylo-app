# Workflow — Scellement des reçus

> Preuve d'achat immuable liée à la transaction Stripe Issuing. PostgreSQL + Prisma.

## Principe
- Chaque achat en magasin (carte Issuing, Option B JIT) doit être adossé à un **reçu scellé** :
  photo du ticket, hash, horodatage serveur, lien avec l'autorisation Stripe.
- Un reçu scellé est **immuable** : aucune mise à jour, uniquement création + invalidation tracée.

## Pipeline
```
PURCHASE_AUTHORIZED (JIT) → RECEIPT_PENDING → RECEIPT_UPLOADED → RECEIPT_SEALED
                                   ↓ (délai dépassé)
                            RECEIPT_MISSING (mission non clôturable)
```

## Règles
1. Upload : photo du reçu → resize on-device → base64 + **sha256 calculé client ET recalculé
   serveur** ; mismatch = rejet `RECEIPT_HASH_MISMATCH` (même mécanique que les photos listing).
2. Scellement = écriture en une transaction :
   `{ receiptId, sha256, sealedAt (horloge serveur), issuingAuthorizationId, amountCents, missionId }`.
   `sealedAt` vient du serveur, jamais du device (horloge mobile non fiable).
3. Rapprochement : `amountCents` du reçu comparé au montant capturé Stripe ;
   écart → `RECEIPT_AMOUNT_MISMATCH`, mission bloquée pour revue **humaine** (pas d'auto-résolution).
4. Immutabilité : pas d'`UPDATE` sur un reçu scellé. Correction = nouveau reçu + ancien marqué
   `SUPERSEDED` avec référence, l'historique reste intègre.
5. Clôture mission impossible tant qu'une autorisation capturée n'a pas son reçu scellé.
6. Le fichier image est adressé par son sha256 (stockage content-addressed) — le hash en DB
   suffit à prouver l'intégrité a posteriori.

## Interdits
- Sceller avec un horodatage client.
- Mutation d'un reçu scellé.
- Clôturer une mission avec des reçus manquants ou en mismatch.
