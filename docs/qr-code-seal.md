# Module — Sceau QR interne (anti « colis vide »)

> Preuve cryptographique que l'acheteur a bien ouvert le colis authentique avant
> libération du séquestre. Protège l'acheteur contre un voyageur qui expédierait
> un colis vide / non conforme.

## Principe

Un code aléatoire opaque (256 bits) est **scellé physiquement à l'intérieur du
colis**. Waylo n'en stocke **que le sha256** (`Mission.innerQrCodeHash`). À la
réception, l'acheteur scanne le code et le poste à `/confirm-collection` ; le
serveur recalcule le hash et le compare en **temps constant** avant toute capture
Stripe. Pas de scan valide ⇒ pas de libération.

Le voyageur ne peut pas forger la preuve : seul l'**acheteur** (authentifié, garde
IDOR) peut confirmer la collecte, et il lui faut le colis physique pour scanner.

## Modèle de données

`Mission.innerQrCodeHash : String?` — sha256 hex (64 car.), nullable.
- `null` ⇒ mission sans sceau ⇒ **chemin de collecte historique** (gate désactivé, rétro-compat).
- Défini ⇒ la collecte exige et vérifie le code brut.

Réf. [`prisma/schema.prisma`](../prisma/schema.prisma) (champ `innerQrCodeHash`) ·
migration `20260618135003_add_inner_qr_code_hash`.

## Helper cryptographique — [`src/missions/qr-proof.ts`](../src/missions/qr-proof.ts)

| Fonction | Rôle |
|---|---|
| `hashQrCode(raw): string` | sha256 hex du code brut (32 o → 64 hex). |
| `qrCodeMatches(raw, storedHashHex): boolean` | `timingSafeEqual` sur les deux buffers ; garde de longueur (sceau mal formé → `false` sans throw). |

## Génération (automatique, idempotente)

Le sceau est généré à l'**entrée du flux transport** — `randomBytes(32).toString('hex')`,
hash persisté, **brut renvoyé une seule fois** dans la réponse (pour impression /
scellage) et **jamais re-stocké en clair**.

| Route | Transition | Comportement |
|---|---|---|
| `POST /:id/ship` | `MATCHED → IN_PROGRESS` | génère systématiquement le sceau ([mission.route.ts](../src/missions/mission.route.ts) ~L1575). |
| `POST /:id/dropoff-receipt` | `{MATCHED\|VALIDATED} → DEPOSITED` | génère **si absent** (mission arrivée à DEPOSITED sans passer par `/ship`) ; **n'écrase jamais** un sceau existant (~L1118). |

Idempotence / concurrence : la génération est incluse dans la transition
conditionnelle `updateMany(where status…)` ; deux appels concurrents → un seul
gagne (`count === 1`), le brut du perdant est jeté (jamais persisté).

## Vérification — `POST /:id/confirm-collection`

([mission.route.ts](../src/missions/mission.route.ts) ~L1183) — réservé à l'acheteur (IDOR → 404).

1. Garde d'état : `DEPOSITED` strict.
2. **Si `innerQrCodeHash` présent** : exige `innerQrCode` (string non vide ≤ 512) dans
   le body ; `typeof` + longueur + `qrCodeMatches`. Échec/absence → **`400 INVALID_QR_PROOF`**,
   **avant toute capture Stripe** (jamais de libération sur preuve invalide).
3. Match (ou sceau absent → chemin historique) → capture hors tx → `VALIDATED` →
   webhook `payment_intent.succeeded` → `PAYOUT`/`COMMISSION` + `TransferOutbox` → `RELEASED`.

> Pas de body schema sur cette route : le corps est optionnel (missions sans sceau =
> corps vide). Un schéma `object` ferait échouer la validation d'un POST sans body.
> Le `innerQrCode` est donc lu et validé à la main.

## Tests

- [`qr-proof.test.ts`](../src/missions/qr-proof.test.ts) — hash, match/mismatch, sceau mal formé.
- [`inner-qr-seal.test.ts`](../src/missions/inner-qr-seal.test.ts) — génération à `/ship` (brut renvoyé 1×, seul le hash persisté) + interlock (le brut débloque la collecte ; un faux → 400).
- [`confirm-collection.test.ts`](../src/missions/confirm-collection.test.ts) cas (F)/(G) — gate match/mismatch.
- [`dropoff-receipt.test.ts`](../src/missions/dropoff-receipt.test.ts) cas (H)/(I) — génération si absent / idempotence si présent.

## Hors périmètre (à décider produit)

- **Distribution physique du brut** vers le système d'impression / fulfillment (le brut
  n'est renvoyé qu'une fois dans la réponse API).
- Chiffrement au repos du `dropOffAccessCode` (AES) — non implémenté.
