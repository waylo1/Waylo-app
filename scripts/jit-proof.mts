/**
 * Script de Preuve (Native Verification — Méthode Doko) du cœur de décision JIT
 * (Stripe Issuing Option B). Spec EXÉCUTABLE et DB-FREE : aucune base, aucune
 * route, aucun réseau — uniquement le contrat pur de
 * `src/services/stripe/jit-handler.service.ts` (aucune réimplémentation).
 *
 * AFFIRME — cas central exigé :
 *   P1 — montant > solde escrow (spendingLimitCents) sur mission saine
 *        → { approved:false, reason:'OVER_BUDGET', declineCode:'insufficient_funds' }.
 *
 * + gardes adjacentes (le refus doit être fail-safe, pas un cas isolé) :
 *   P2 — montant > hard cap 150% du budget → declineCode:'spending_controls'.
 *   P3 — escrow ≠ HELD (mission saine) → declineCode:'insufficient_funds'.
 *   P4 — contrôle positif : montant ≤ plafond → { approved:true, declineCode:null }.
 *
 * ÉTAT INITIAL = RED : le service n'expose que des signatures (NOT_IMPLEMENTED).
 * Ce script échoue volontairement (exit 1) tant que `decideJitAuthorization`
 * n'est pas implémenté — c'est la preuve que le contrat est défini AVANT le code.
 * Il passe au VERT (exit 0) sans modification une fois la logique écrite.
 *
 * Lancement : tsx scripts/jit-proof.mts
 */
import {
  decideJitAuthorization,
  type JitAuthorizationDecision,
  type JitDecisionInput,
} from '../src/services/stripe/jit-handler.service'

const BUDGET_CENTS = 40_000
const HARD_CAP_CENTS = Math.floor((BUDGET_CENTS * 15) / 10) // 60_000 (backstop 150%)

/** Mission saine (IN_PROGRESS), escrow HELD, plafond figé = budget (pas de substitution). */
function healthyInput(requestedAmountCents: number): JitDecisionInput {
  return {
    requestedAmountCents,
    escrow: { status: 'HELD', spendingLimitCents: BUDGET_CENTS },
    mission: { status: 'IN_PROGRESS', substitutionAuthorized: false, budgetCents: BUDGET_CENTS },
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[jit-proof] ÉCHEC — ${message}`)
  }
}

function assertDecision(
  actual: JitAuthorizationDecision,
  expected: JitAuthorizationDecision,
  label: string,
): void {
  assert(
    actual.approved === expected.approved &&
      actual.reason === expected.reason &&
      actual.declineCode === expected.declineCode,
    `${label} — attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(actual)}`,
  )
}

function run(): void {
  // P1 — Cas central : montant strictement supérieur au solde/plafond escrow.
  assertDecision(
    decideJitAuthorization(healthyInput(BUDGET_CENTS + 1)),
    { approved: false, reason: 'OVER_BUDGET', declineCode: 'insufficient_funds' },
    'P1 montant > solde escrow → decline insufficient_funds',
  )

  // P2 — Backstop hard cap 150% : refus indépendant du plafond opérationnel.
  assertDecision(
    decideJitAuthorization(healthyInput(HARD_CAP_CENTS + 1)),
    { approved: false, reason: 'HARD_CAP_EXCEEDED', declineCode: 'spending_controls' },
    'P2 montant > hard cap 150% → decline spending_controls',
  )

  // P3 — Escrow non HELD (ex. RELEASED/REFUNDED) : refus même montant raisonnable.
  assertDecision(
    decideJitAuthorization({
      requestedAmountCents: 10_000,
      escrow: { status: 'RELEASED', spendingLimitCents: BUDGET_CENTS },
      mission: { status: 'IN_PROGRESS', substitutionAuthorized: false, budgetCents: BUDGET_CENTS },
    }),
    { approved: false, reason: 'ESCROW_NOT_HELD', declineCode: 'insufficient_funds' },
    'P3 escrow ≠ HELD → decline insufficient_funds',
  )

  // P4 — Contrôle positif : montant dans le plafond → approbation, aucun code.
  assertDecision(
    decideJitAuthorization(healthyInput(BUDGET_CENTS)),
    { approved: true, reason: 'WITHIN_BUDGET', declineCode: null },
    'P4 montant = plafond (borne incluse) → approved',
  )

  console.log('[jit-proof] VERT — 4/4 assertions du contrat JIT vérifiées.')
}

try {
  run()
  process.exit(0)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith('NOT_IMPLEMENTED')) {
    console.error(
      `[jit-proof] RED (attendu à l'init) — cœur non implémenté : ${message}\n` +
        '            Le contrat est défini ; implémenter decideJitAuthorization pour passer au VERT.',
    )
  } else {
    console.error(message)
  }
  process.exit(1)
}
