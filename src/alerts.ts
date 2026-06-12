import { appendFileSync } from 'node:fs'

/**
 * Alertes opérationnelles — hook UNIQUE partagé par les webhooks Stripe, le
 * worker de transfert et la réconciliation.
 *
 * Deux familles d'émission :
 * - post-commit (chemin nominal) : l'alerte ne part que si l'effet a committé ;
 * - pré-throw (abort non auto-réparable) : l'alerte part AVANT le rollback —
 *   sinon Stripe rejoue en silence 3 jours puis désactive l'endpoint.
 *
 * Sévérité : dérivée DU CODE (source unique de vérité, SEVERITY_BY_CODE), pas
 * choisie au site d'émission. Invariant : une alerte critical ne peut JAMAIS
 * finir en simple stderr silencieux — le canal par défaut la route aussi vers
 * un sink dédié persistant (fichier NDJSON), et le fallback d'échec de sink
 * retente ce sink dédié.
 */
export type AlertCode =
  | 'LEDGER_INVARIANT_BROKEN'
  | 'PAYOUT_NOT_SETTLED'
  | 'ORPHAN_TRANSFER'
  | 'TRANSFER_MISSING_ON_STRIPE'
  | 'AUTHORIZATION_WITHOUT_CAPTURE'
  | 'CAPTURE_WITHOUT_LEDGER'
  | 'LEDGER_CAPTURE_NOT_CONFIRMED'
  | 'TRAVELER_ACCOUNT_MISSING'
  | 'TRANSFER_ABANDONED'
  | 'WEBHOOK_ABORT_NON_RECOVERABLE'
  | 'ISSUING_JIT_LOOKUP_ERROR'
  | 'WEBHOOK_PROCESSING_FAILED'
  | 'RECONCILIATION_RUN_FAILED'

export type AlertSeverity = 'info' | 'warn' | 'critical'

/** Ce que les sites d'émission construisent (la sévérité est dérivée du code). */
export interface OpsAlertInput {
  code: AlertCode
  message: string
  details: Record<string, unknown>
}

/** Ce que les sinks reçoivent. */
export interface OpsAlert extends OpsAlertInput {
  severity: AlertSeverity
}

export type AlertSink = (alert: OpsAlert) => void

/**
 * critical = argent pris/perdu/incohérent ou condition terminale exigeant un
 * humain. warn = dégradation visible et bornée (argent sûr, action connue).
 */
const SEVERITY_BY_CODE: Record<AlertCode, AlertSeverity> = {
  LEDGER_INVARIANT_BROKEN: 'critical', // corruption comptable
  CAPTURE_WITHOUT_LEDGER: 'critical', // argent pris, non journalisé
  LEDGER_CAPTURE_NOT_CONFIRMED: 'critical', // journalisé, non confirmé côté Stripe
  ORPHAN_TRANSFER: 'critical', // mouvement sortant sans PAYOUT
  TRANSFER_MISSING_ON_STRIPE: 'critical', // réglé en DB, introuvable chez Stripe
  AUTHORIZATION_WITHOUT_CAPTURE: 'critical', // autorisation orpheline (KYC/AML)
  TRANSFER_ABANDONED: 'critical', // terminal, « needs human »
  WEBHOOK_ABORT_NON_RECOVERABLE: 'critical', // OVER_REFUND, REFUND_LEDGER_AHEAD_OF_STRIPE…
  PAYOUT_NOT_SETTLED: 'warn', // latence worker normale au début, nag quotidien sinon
  TRAVELER_ACCOUNT_MISSING: 'warn', // argent visible et sûr, action d'intervention connue
  ISSUING_JIT_LOOKUP_ERROR: 'warn', // refus fail-safe ; en rafale = incident infra
  WEBHOOK_PROCESSING_FAILED: 'warn', // erreur INATTENDUE (rollback, Stripe rejoue) ; persistant = endpoint désactivable
  RECONCILIATION_RUN_FAILED: 'warn', // le monitoring lui-même est en panne — les invariants ne sont plus vérifiés
}

export function toOpsAlert(input: OpsAlertInput): OpsAlert {
  return { severity: SEVERITY_BY_CODE[input.code], ...input }
}

/** Canal d'alerte par niveau — c'est ICI qu'on branche la prod. */
export interface AlertChannel {
  info(alert: OpsAlert): void
  warn(alert: OpsAlert): void
  critical(alert: OpsAlert): void
}

const stderrLine = (alert: OpsAlert): void => {
  console.error(JSON.stringify({ level: alert.severity, kind: 'ops_alert', ...alert }))
}

/** Sink critique dédié, DISTINCT du stderr : NDJSON append-only persistant. */
const CRITICAL_ALERTS_FILE =
  process.env.WAYLO_CRITICAL_ALERTS_FILE ?? 'alerts-critical.ndjson'

const appendCriticalFile = (alert: OpsAlert): void => {
  appendFileSync(
    CRITICAL_ALERTS_FILE,
    JSON.stringify({ at: new Date().toISOString(), ...alert }) + '\n',
  )
}

/**
 * Canal par défaut. info/warn → stderr structuré. critical → stderr ET sink
 * dédié persistant (jamais stderr seul).
 *
 * TODO(prod): brancher ici le canal critique réel (PagerDuty/Slack webhook)
 * quand les credentials existeront — remplacer/compléter appendCriticalFile,
 * ne PAS supprimer la persistance locale (filet si le canal externe est down).
 */
export const defaultAlertChannel: AlertChannel = {
  info: stderrLine,
  warn: stderrLine,
  critical: alert => {
    stderrLine(alert)
    appendCriticalFile(alert)
  },
}

export function channelToSink(channel: AlertChannel): AlertSink {
  return alert => channel[alert.severity](alert)
}

export const defaultAlertSink: AlertSink = channelToSink(defaultAlertChannel)

/**
 * Émission blindée : dérive la sévérité, appelle le sink, et retourne l'alerte
 * enrichie (pour les appelants qui la collectent, ex. réconciliation).
 * Un sink qui throw ne doit JAMAIS casser un chemin webhook (un 500
 * post-commit ferait rejouer un effet déjà appliqué) — et un critical dont le
 * sink échoue est retenté sur le sink dédié avant de finir en stderr.
 */
export function safeEmit(sink: AlertSink | undefined, input: OpsAlertInput): OpsAlert {
  const alert = toOpsAlert(input)
  try {
    ;(sink ?? defaultAlertSink)(alert)
  } catch (err) {
    console.error(
      JSON.stringify({ level: 'error', kind: 'alert_sink_failed', alert, err: String(err) }),
    )
    if (alert.severity === 'critical') {
      try {
        appendCriticalFile(alert)
      } catch {
        // stderr ci-dessus reste la trace de dernier recours
      }
    }
  }
  return alert
}
