# Économie de l'horodatage TSA (RFC 3161) — preuves QPP

> Analyse au 2026-07-02. Convention Waylo : tous les montants en **centimes Int**.
> Constante code associée : `ESTIMATED_COST_PER_TOKEN_CENTS` dans `src/security/tsa.config.ts`.

## 1. Coût par jeton selon le fournisseur

### Chaîne actuelle (endpoints publics)

| Fournisseur | Endpoint | Coût/jeton | Contrepartie |
|---|---|---|---|
| Sectigo | `https://timestamp.sectigo.com` | **0 ¢** | Rate-limit non contractuel, aucun SLA, révocable sans préavis |
| Certum (public) | `http://time.certum.pl` | **0 ¢** | Idem — l'ancrage eIDAS du QTSP ne vaut pas garantie contractuelle sur l'endpoint gratuit |
| DigiCert | `http://timestamp.digicert.com` | **0 ¢** | Idem |

**Coût marginal actuel : 0 ¢/preuve.** Le "coût" réel est un risque opérationnel
(indisponibilité, bannissement — précédent FreeTSA), mitigé par le failover à 3 fournisseurs.

### Offres qualifiées eIDAS sous contrat (référence publique)

| Fournisseur | Modèle | Coût/jeton constaté |
|---|---|---|
| StampR | À l'unité | ~250 ¢ (2,50 €) |
| StampR | Abonnement | ~50 ¢ (0,50 €) |
| Disig | Packs prépayés 100 → 10 000 jetons (validité 3 ans) | ~10–20 ¢ dégressif |
| GlobalTrust / Certum (packs pro) | Packs annuels, quota extensible | ordre de grandeur 2–10 ¢ en volume |

**Hypothèse de provisionnement retenue : 5 ¢/jeton** (`ESTIMATED_COST_PER_TOKEN_CENTS = 5`) —
milieu de fourchette d'un contrat QTSP en volume (10k+/an), prudent sans être punitif.

## 2. Projection annuelle

Hypothèse : 1 jeton par preuve scellée, ~2 preuves horodatées par mission (achat scellé + livraison).

| Missions/an | Jetons/an (~×2) | Coût chaîne publique | Coût provisionné QTSP (5 ¢) | Coût haut de fourchette (20 ¢) |
|---|---|---|---|---|
| 10 000 | 20 000 | 0 € | **1 000 €** | 4 000 € |
| 50 000 | 100 000 | 0 € | **5 000 €** | 20 000 € |
| 100 000 | 200 000 | 0 € | **10 000 €** | 40 000 € |

## 3. Recommandation — seuil de facturation client

- **Phase actuelle (pré-bêta → <10k missions/an)** : rester sur la chaîne publique gratuite.
  Coût nul, risque couvert par le failover. **Ne pas facturer** : l'horodatage est un coût
  d'infrastructure interne, pas une ligne visible client.
- **Seuil de bascule QTSP contractuel : ~10 000 missions/an** (≈20 000 jetons). C'est le
  volume où (a) un rate-limit public devient un risque réel de production, et (b) la valeur
  probante contractuelle devient nécessaire face aux litiges (ACPR/eIDAS). Budget : ~1 000 €/an.
- **Seuil de déclenchement de la facturation client : quand le coût TSA dépasse ~0,1 % du
  panier moyen.** Avec un panier moyen estimé 100 € (10 000 ¢), 2 jetons × 5 ¢ = 10 ¢ = 0,1 %
  du GMV : négligeable. **Recommandation : absorber le coût dans la commission d'escrow
  jusqu'à 100k missions/an**, et ne l'exposer en ligne de frais ("frais de certification de
  preuve") que si un contrat QTSP premium (>20 ¢/jeton, ex. exigence d'archivage qualifié)
  devenait obligatoire réglementairement. Une ligne de 10-40 ¢ par mission dégraderait la
  conversion pour un gain marginal.

## 4. Suivi

Chaque horodatage réussi est logué par `requestTimestamp()` avec `providerId`,
`estimatedCostCents` et la durée — l'agrégation mensuelle de ces logs donne le coût
réel constaté et déclenche la revue du seuil ci-dessus.

Sources tarifaires : [StampR pricing](https://stampr.eu/en/pricing),
[Disig price list](https://eidas.disig.sk/en/qualified-electronic-time-stamps/pricelist/),
[GlobalTrust qualified timestamp](https://globaltrust.eu/en/qualified-timestamp/),
[qtsa.eu](https://qtsa.eu/).
