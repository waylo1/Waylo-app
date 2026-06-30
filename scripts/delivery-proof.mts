/**
 * Script de Preuve (Native Verification — Méthode Doko) du cœur de décision
 * « Réception » (Proof of Delivery). Spec EXÉCUTABLE et DB-FREE : aucune base,
 * aucune route, aucun réseau — uniquement le contrat pur de
 * `src/services/delivery/delivery.service.ts` (aucune réimplémentation).
 *
 * Le sceau QR est généré via le helper RÉEL `hashQrCode` (src/missions/qr-proof.ts) :
 * la preuve s'appuie sur la même chaîne cryptographique que /confirm-collection —
 * pas un mock. Système fondé sur des preuves, pas des déclarations.
 *
 * AFFIRME les trois verdicts atomiques :
 *   C1 — scan valide (sceau prouvé, mission DEPOSITED, scan postérieur au départ)
 *        → { status:'READY_TO_RELEASE', readyToRelease:true }.
 *   C2 — scan sur transaction déjà délivrée (escrow RELEASED)
 *        → { status:'DOUBLE_SCAN_ERROR', readyToRelease:false } (idempotence).
 *   C3 — scan AVANT la date de voyage (scannedAt < shippedAt)
 *        → { status:'EARLY_SCAN_ERROR', readyToRelease:false }.
 *
 * ÉTAT INITIAL = RED : le service n'expose que la signature (NOT_IMPLEMENTED).
 * Exit 1 tant que `decideDelivery` n'est pas implémenté ; exit 0 (VERT) sans
 * modification une fois la logique écrite.
 *
 * Lancement : tsx scripts/delivery-proof.mts
 */
import {
  decideDelivery,
  type DeliveryDecision,
  type DeliveryProof,
  type DeliveryStateFacts,
} from '../src/services/delivery/delivery.service'
import { hashQrCode } from '../src/missions/qr-proof'

// Sceau interne : code brut connu de la preuve, seul son sha256 vit côté mission.
const RAW_QR = 'pod-proof-raw-qr-code-256bits-deadbeef'
const SEAL_HASH = hashQrCode(RAW_QR)

// Chronologie serveur figée (déterminisme) : départ < scan valide.
const SHIPPED_AT = new Date('2026-06-20T08:00:00.000Z')
const SCAN_AT = new Date('2026-06-25T14:30:00.000Z') // 5 jours après le départ

/** Scan acheteur sain : bon code, géo + signature présentes, horodatage serveur. */
function validProof(scannedAt: Date = SCAN_AT): DeliveryProof {
  return {
    missionId: 'm-pod-proof',
    scannedQrCode: RAW_QR,
    scannedAt,
    location: { latitude: 48.8566, longitude: 2.3522 },
    signature: 'sig-buyer-pod-proof',
  }
}

/** Mission DEPOSITED, escrow HELD, sceau posé, expédiée → état nominal de collecte. */
function depositedState(): DeliveryStateFacts {
  return {
    missionStatus: 'DEPOSITED',
    escrowStatus: 'HELD',
    innerQrSealHash: SEAL_HASH,
    shippedAt: SHIPPED_AT,
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[delivery-proof] ÉCHEC — ${message}`)
  }
}

function assertDecision(
  actual: DeliveryDecision,
  expected: DeliveryDecision,
  label: string,
): void {
  assert(
    actual.status === expected.status && actual.readyToRelease === expected.readyToRelease,
    `${label} — attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(actual)}`,
  )
}

function run(): void {
  // C1 — Cas nominal : sceau prouvé, mission au bon stade, scan postérieur au départ.
  assertDecision(
    decideDelivery(validProof(), depositedState()),
    { status: 'READY_TO_RELEASE', readyToRelease: true },
    'C1 scan valide → READY_TO_RELEASE',
  )

  // C2 — Idempotence : escrow déjà RELEASED (collecte actée) → aucun re-release.
  assertDecision(
    decideDelivery(validProof(), {
      missionStatus: 'RELEASED',
      escrowStatus: 'RELEASED',
      innerQrSealHash: SEAL_HASH,
      shippedAt: SHIPPED_AT,
    }),
    { status: 'DOUBLE_SCAN_ERROR', readyToRelease: false },
    'C2 transaction déjà délivrée → DOUBLE_SCAN_ERROR',
  )

  // C3 — Scan AVANT le départ (1 jour avant l'expédition) : preuve impossible.
  assertDecision(
    decideDelivery(validProof(new Date('2026-06-19T08:00:00.000Z')), depositedState()),
    { status: 'EARLY_SCAN_ERROR', readyToRelease: false },
    'C3 scan avant date de voyage → EARLY_SCAN_ERROR',
  )

  console.log('[delivery-proof] VERT — 3/3 verdicts du contrat Réception (PoD) vérifiés.')
}

try {
  run()
  process.exit(0)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith('NOT_IMPLEMENTED')) {
    console.error(
      `[delivery-proof] RED (attendu à l'init) — cœur non implémenté : ${message}\n` +
        '            Le contrat est défini ; implémenter decideDelivery pour passer au VERT.',
    )
  } else {
    console.error(message)
  }
  process.exit(1)
}
