import Stripe from 'stripe'
import { runReconciliation } from '../workers/reconciliation'
import type { ReconciliationAlert } from '../workers/reconciliation'
import type { AlertSeverity } from '../alerts'

/**
 * Entrypoint CLI/Cron — déclenche UN run de réconciliation ledger puis sort.
 *
 * Distinct du cron in-process (startReconciliationCron, server.ts) : ici PAS de
 * boucle, PAS de serveur HTTP — un process court, idéal pour un cron externe
 * (crontab, Fly Machines scheduled, k8s CronJob, GitHub Actions). Lecture seule :
 * runReconciliation DÉTECTE et ALERTE, ne mute JAMAIS le ledger.
 *
 * Sink d'alerte : défaut (onAlert omis) → stderr structuré + NDJSON critique
 * persistant (cf. alerts.ts) — exactement ce qu'un collecteur de logs cron veut.
 *
 * Stripe OPTIONNEL : avec STRIPE_SECRET_KEY, les contrôles de confrontation à
 * l'argent réel (transferts/captures Stripe) sont activés ; sans, seuls les
 * invariants DB (A/B/C, PAYOUT↔outbox, autorisations orphelines) tournent.
 *
 * Codes de sortie (contrat cron) :
 *   0  run OK, aucune alerte (ledger sain).
 *   1  run EN ÉCHEC (exception) — la couche de détection est morte.
 *   2  run OK mais alertes détectées, UNIQUEMENT si --fail-on-alert (ou
 *      RECONCILIATION_FAIL_ON_ALERT=1) ; sinon 0 (les alertes partent déjà au sink).
 */

/** DATABASE_URL est la seule variable STRICTEMENT requise (Prisma). */
function missingDatabaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.DATABASE_URL
}

/** Vrai si l'opérateur exige un exit non-zéro quand des alertes sont détectées. */
function failOnAlert(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--fail-on-alert') || env.RECONCILIATION_FAIL_ON_ALERT === '1'
}

/** Décompte des alertes par sévérité — résumé scannable pour le log cron. */
function countBySeverity(alerts: ReconciliationAlert[]): Record<AlertSeverity, number> {
  const counts: Record<AlertSeverity, number> = { info: 0, warn: 0, ops: 0, critical: 0 }
  for (const alert of alerts) counts[alert.severity] += 1
  return counts
}

export async function triggerReconciliation(): Promise<number> {
  if (missingDatabaseUrl()) {
    console.error('DATABASE_URL manquante — réconciliation refusée.')
    return 1
  }

  // Import APRÈS la validation env : PrismaClient lit DATABASE_URL à
  // l'instanciation (miroir de server.ts). Stripe optionnel.
  const { prisma } = await import('../db')
  const stripeKey = process.env.STRIPE_SECRET_KEY
  const stripe = stripeKey ? new Stripe(stripeKey) : undefined
  if (!stripe) {
    console.error(
      JSON.stringify({
        level: 'warn',
        kind: 'reconciliation_cli',
        msg: 'STRIPE_SECRET_KEY absente — contrôles de confrontation Stripe sautés (invariants DB seuls)',
      }),
    )
  }

  try {
    // onAlert omis → sink par défaut (stderr + NDJSON critique persistant).
    const alerts = await runReconciliation({ prisma, stripe })
    const bySeverity = countBySeverity(alerts)
    console.log(
      JSON.stringify({
        level: alerts.length === 0 ? 'info' : 'warn',
        kind: 'reconciliation_cli',
        msg: 'réconciliation terminée',
        alerts: alerts.length,
        bySeverity,
        stripeChecks: Boolean(stripe),
      }),
    )
    if (alerts.length > 0 && failOnAlert()) return 2
    return 0
  } catch (err) {
    // La détection elle-même a planté : signal opérationnel le plus fort.
    console.error(
      JSON.stringify({
        level: 'critical',
        kind: 'reconciliation_cli',
        msg: 'réconciliation échouée — invariants non vérifiés',
        err: String(err),
      }),
    )
    return 1
  } finally {
    await prisma.$disconnect()
  }
}

// Exécution directe uniquement — un import (test) est sans effet.
if (require.main === module) {
  triggerReconciliation()
    .then(code => process.exit(code))
    .catch((err: unknown) => {
      console.error(String(err))
      process.exit(1)
    })
}
