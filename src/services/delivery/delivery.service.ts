import { EscrowStatus, MissionStatus } from '../../generated/prisma'
import { qrCodeMatches } from '../../missions/qr-proof'

/**
 * Cœur de décision « Réception » (Proof of Delivery — PoD).
 *
 * RÔLE : décider, à partir d'un scan acheteur, si le séquestre est PRÊT À ÊTRE
 * LIBÉRÉ — fonction PURE, sans I/O, testable hors DB (proof DB-free
 * `scripts/delivery-proof.mts`). La libération réelle (capture Stripe, transition
 * DEPOSITED→VALIDATED→RELEASED) reste la responsabilité de la route/​worker ; ce
 * cœur n'émet qu'un VERDICT atomique.
 *
 * Le système est fondé sur des PREUVES, pas des déclarations : le seul chemin vers
 * `READY_TO_RELEASE` exige la correspondance cryptographique du sceau QR interne
 * (anti « colis vide », `qrCodeMatches` en temps constant) — l'acheteur ne « déclare »
 * jamais la réception, il la PROUVE en scannant le code scellé dans le colis.
 *
 * INVARIANTS (cf. .claude/CLAUDE.md, gotchas.md) :
 *  - Aucun I/O : ni DB, ni réseau, ni horloge interne. `scannedAt` est fourni par
 *    l'appelant (horodatage SERVEUR, jamais l'horloge du device — anti-antidatage).
 *  - Défaut = REFUS : tout doute (déjà collecté, scan antérieur au départ, sceau
 *    absent/non concordant) ⇒ pas de libération.
 *  - Idempotence : un re-scan d'une mission déjà collectée/libérée NE re-libère
 *    jamais (DOUBLE_SCAN_ERROR prime sur tout le reste).
 *
 * ÉTAT : SIGNATURES UNIQUEMENT (init). Le corps de `decideDelivery` lève
 * NOT_IMPLEMENTED ; `scripts/delivery-proof.mts` est le spec exécutable (RED) qui
 * passera au VERT à l'implémentation.
 */

// ---------------------------------------------------------------------------
// CONTRAT DE DONNÉE — Entrée : la preuve de scan
// ---------------------------------------------------------------------------

/**
 * Coordonnée géographique du scan (preuve de présence physique à la collecte).
 * Degrés décimaux WGS84 — l'invariant « Int partout » est MONÉTAIRE (centimes) et
 * ne s'applique pas aux coordonnées. `null` côté `DeliveryProof` si non capturée.
 */
export interface GeoPoint {
  latitude: number
  longitude: number
}

/**
 * Preuve de réception soumise par l'acheteur au moment du scan. Métadonnées de
 * scan + horodatage serveur + géolocalisation + signature d'attestation.
 *
 * `scannedQrCode` = code BRUT scanné (jamais persisté en clair ; seul son sha256
 * est stocké côté mission). Il est confronté au sceau via `qrCodeMatches`.
 */
export interface DeliveryProof {
  /** Mission scannée (clé de corrélation avec l'état persisté). */
  missionId: string
  /** Code QR interne BRUT scanné dans le colis (preuve anti « colis vide »). */
  scannedQrCode: string
  /** Horodatage SERVEUR du scan (jamais l'horloge du device — anti-antidatage). */
  scannedAt: Date
  /** Géolocalisation du scan, ou null si non capturée. */
  location: GeoPoint | null
  /** Attestation/signature acheteur (référence opaque), ou null. */
  signature: string | null
}

/**
 * Faits d'état NORMALISÉS (déjà lus en DB par la route) nécessaires à la décision.
 * Aucune dépendance Prisma runtime : seuls les TYPES d'enum sont importés (DB-free).
 *  - `missionStatus`/`escrowStatus` : détection de collecte/libération déjà actée.
 *  - `innerQrSealHash` : sha256 (hex) du sceau interne, ou null si la mission n'en
 *    porte pas (chemin historique sans sceau) → refus, jamais de release aveugle.
 *  - `shippedAt` : horodatage serveur du départ/expédition (posé à /ship). null =
 *    pas encore expédiée → tout scan est nécessairement prématuré.
 */
export interface DeliveryStateFacts {
  missionStatus: MissionStatus
  escrowStatus: EscrowStatus
  innerQrSealHash: string | null
  shippedAt: Date | null
}

// ---------------------------------------------------------------------------
// CONTRAT DE DONNÉE — Sortie : le verdict atomique du scan
// ---------------------------------------------------------------------------

/**
 * Verdict atomique du scan. `READY_TO_RELEASE` est l'UNIQUE statut autorisant la
 * suite (capture/libération) ; tous les autres sont des refus fail-safe, leur
 * valeur sert directement de code d'erreur API ({ error: 'SNAKE_CASE_CODE' }).
 */
export type DeliveryStatus =
  | 'READY_TO_RELEASE' // sceau prouvé, mission au bon stade, scan postérieur au départ
  | 'DOUBLE_SCAN_ERROR' // collecte/libération déjà actée — idempotence, aucun re-release
  | 'EARLY_SCAN_ERROR' // scan antérieur à l'expédition (colis pas encore parti)
  | 'NO_INNER_SEAL' // mission sans sceau interne — pas de preuve possible
  | 'INVALID_QR_PROOF' // code scanné ≠ sceau scellé (échec temps constant)

/** Décision pure : statut atomique + projection booléenne de commodité. */
export interface DeliveryDecision {
  /** Verdict atomique. Sert de code d'audit/erreur pour les refus. */
  status: DeliveryStatus
  /** `true` ⇔ `status === 'READY_TO_RELEASE'` (unique chemin de libération). */
  readyToRelease: boolean
}

// ---------------------------------------------------------------------------
// CŒUR PUR
// ---------------------------------------------------------------------------

/**
 * Statuts mission traduisant une collecte/libération DÉJÀ actée : à ce stade le
 * séquestre est capturé/libéré, tout nouveau scan est un replay (DOUBLE_SCAN).
 * VALIDATED = acheteur a confirmé la collecte (capture déclenchée) ; RELEASED =
 * fonds versés. (cf. enum MissionStatus, schema.prisma)
 */
const COLLECTED_STATUSES: ReadonlySet<MissionStatus> = new Set([
  MissionStatus.VALIDATED,
  MissionStatus.RELEASED,
])

/** Projette un statut vers la décision (readyToRelease dérivé, jamais divergent). */
function decision(status: DeliveryStatus): DeliveryDecision {
  return { status, readyToRelease: status === 'READY_TO_RELEASE' }
}

/**
 * CŒUR PUR. Décide si un scan acheteur rend le séquestre libérable.
 * Déterministe, sans I/O. Cible du proof DB-free.
 *
 * Ordre de gardes (fail-safe, défaut = refus) :
 *  1. mission collectée/libérée (VALIDATED/RELEASED, ou escrow RELEASED)
 *     → DOUBLE_SCAN_ERROR  (idempotence — prime sur tout : un replay ne re-libère pas)
 *  2. pas encore expédiée (shippedAt null) ou scan AVANT le départ
 *     → EARLY_SCAN_ERROR
 *  3. sceau interne absent → NO_INNER_SEAL
 *  4. code scanné ≠ sceau (temps constant) → INVALID_QR_PROOF
 *  5. sinon → READY_TO_RELEASE
 */
export function decideDelivery(
  proof: DeliveryProof,
  state: DeliveryStateFacts,
): DeliveryDecision {
  // 1. Idempotence d'abord : une collecte/libération déjà actée n'est JAMAIS
  // re-déclenchée par un re-scan (replay), quel que soit l'état du sceau ou la date.
  if (state.escrowStatus === EscrowStatus.RELEASED || COLLECTED_STATUSES.has(state.missionStatus)) {
    return decision('DOUBLE_SCAN_ERROR')
  }

  // 2. Borne temporelle : un colis pas encore expédié (ou scanné avant son départ)
  // ne peut pas être physiquement reçu — preuve impossible, refus.
  if (state.shippedAt === null || proof.scannedAt.getTime() < state.shippedAt.getTime()) {
    return decision('EARLY_SCAN_ERROR')
  }

  // 3. Sceau interne obligatoire : pas de release sur une mission sans preuve possible.
  if (state.innerQrSealHash === null) {
    return decision('NO_INNER_SEAL')
  }

  // 4. Preuve cryptographique en temps constant (anti « colis vide ») — même
  // chaîne que /confirm-collection, aucune divergence.
  if (!qrCodeMatches(proof.scannedQrCode, state.innerQrSealHash)) {
    return decision('INVALID_QR_PROOF')
  }

  return decision('READY_TO_RELEASE')
}
