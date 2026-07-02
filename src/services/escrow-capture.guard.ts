import { WatchdogExhaustedError } from '@waylo/shared/automation'
import { AlertSink, safeEmit } from '../alerts'
import { AppError } from '../errors/app.error'
import {
  captureEscrowFunds,
  CaptureContext,
  CaptureEscrowResult,
  CaptureStripeClient,
} from './escrow.service'

/**
 * Garde de capture HTTP (fail-fast) — wrapper UNIQUE des routes autour de
 * `captureEscrowFunds`. Vit HORS de escrow.service.ts : le service reste pur
 * (aucune écriture DB, aucun mapping HTTP, doctrine Audit-00), la garde porte
 * l'observabilité et l'arrêt net.
 *
 * GUARD CLAUSE : si l'alias 'stripe-capture' épuise ses retries
 * (WatchdogExhaustedError — réseau/timeout Stripe persistant), on émet
 * l'alerte critique CAPTURE_FAILED (stderr + NDJSON + webhook Slack via
 * safeEmit) PUIS on lève AppError('ESCROW_CAPTURE_FAILED', 502). Le throw
 * interrompt l'appelant AVANT sa transaction de statut : le statut
 * logistique/métier ne peut JAMAIS avancer si la capture Stripe a échoué.
 *
 * Les EscrowCaptureError du pré-check (ESCROW_NOT_FOUND, ESCROW_NOT_HELD,
 * SUBSTITUTION_HARD_CAP_EXCEEDED) sont relancées TELLES QUELLES : chaque
 * route conserve son mapping HTTP existant — la garde ne traite que
 * l'épuisement des retries, invisible pour tout autre chemin d'erreur.
 */
export async function captureEscrowFundsGuarded(
  missionId: string,
  stripe: CaptureStripeClient,
  context: CaptureContext,
  onAlert?: AlertSink,
): Promise<CaptureEscrowResult> {
  try {
    return await captureEscrowFunds(missionId, stripe, context)
  } catch (err) {
    if (err instanceof WatchdogExhaustedError) {
      safeEmit(onAlert, {
        code: 'CAPTURE_FAILED',
        message:
          "Capture Stripe échouée après épuisement des retries de l'alias stripe-capture — statut métier NON modifié, intervention admin requise",
        details: {
          missionId,
          context,
          attempts: err.attempts,
          lastError: String(err.lastError),
        },
      })
      throw new AppError('ESCROW_CAPTURE_FAILED', 502)
    }
    throw err
  }
}
