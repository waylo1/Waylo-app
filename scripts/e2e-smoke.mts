/**
 * Smoke test E2E — parcours nominal d'une mission de bout en bout.
 *
 * Rejoue le cycle de vie complet à travers les VRAIS handlers de routes
 * (buildApp + app.inject), avec :
 *   - un faux Stripe injecté pour paymentIntents.create / capture (T0 + T1) ;
 *   - un webhook payment_intent.succeeded SIGNÉ pour la libération (T2 → RELEASED).
 * Pattern repris de src/capture-lifecycle.test.ts (test E).
 *
 * Cycle vérifié :
 *   CREATED → FUNDED → MATCHED → IN_PROGRESS → AWAITING_VALIDATION → VALIDATED → RELEASED
 *
 * ISOLATION : cible TOUJOURS la base waylo_test (purge en début ET fin de run).
 * Garde-fou : refus de démarrer si DATABASE_URL ne vise pas waylo_test.
 *
 * PRÉREQUIS (hors périmètre du script) : Postgres up et schéma waylo_test à jour
 *   (`DATABASE_URL=...waylo_test npx prisma migrate deploy`). Lancement :
 *   `npm run test:e2e`. Sortie process : 0 si tous les contrôles passent, 1 sinon.
 */
import Stripe from 'stripe'
import type { PaymentIntentClient } from '../src/missions/mission.route'

// ── Environnement (fixé AVANT tout import de ../src/* : db + routes lisent
// l'env à l'instanciation). On respecte une DATABASE_URL fournie uniquement si
// elle vise déjà waylo_test ; sinon on force l'URL d'isolation locale. Les
// secrets Stripe/JWT ne servent qu'à satisfaire le démarrage + signer le
// webhook localement (aucun appel réseau Stripe réel).
const DEFAULT_TEST_DB = 'postgresql://flipsync:flipsync@localhost:5433/waylo_test'
if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.includes('waylo_test')) {
  process.env.DATABASE_URL = DEFAULT_TEST_DB
}
process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET ||= 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET ||= 'whsec_test_issuing'
process.env.JWT_SECRET ||= 'jwt_smoke_secret_waylo'

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET // = celui que lit la route

const BUDGET_CENTS = 5_000 // 50 €
const COMMISSION_CENTS = 500 // 5 € — exerce le split PAYOUT/COMMISSION
const RECEIPT_CENTS = 4_500 // 45 € (≤ budget)
const AUTHORIZED_CENTS = BUDGET_CENTS + COMMISSION_CENTS // séquestre = budget + commission (cf. /intent)

// Faux Stripe : create renvoie un PI déterministe par mission, capture no-op.
const fakeStripe: PaymentIntentClient = {
  paymentIntents: {
    create: async params => ({
      id: `pi_${params.metadata.missionId}`,
      client_secret: `cs_test_${params.metadata.missionId}`,
    }),
    capture: async id => ({ id }),
  },
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL?.includes('waylo_test')) {
    throw new Error('Garde-fou : DATABASE_URL doit cibler waylo_test')
  }

  const { buildApp } = await import('../src/app')
  const { prisma } = await import('../src/db')

  const stripeSigner = new Stripe(process.env.STRIPE_SECRET_KEY as string)
  const app = await buildApp({ stripe: fakeStripe })

  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'OK ' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  }
  const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` })
  const missionStatus = async (id: string): Promise<string> =>
    (await prisma.mission.findUniqueOrThrow({ where: { id } })).status

  const purge = async (): Promise<void> => {
    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.issuingAuthorizationLog.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.adminAuditLog.deleteMany()
    await prisma.user.deleteMany()
  }

  try {
    console.log('=== SMOKE E2E — parcours mission nominal (waylo_test) ===')
    await purge()

    // 1) Inscription acheteur + voyageur (JWT).
    const regBuyer = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'smoke-buyer@waylo.test', password: 'motdepasse-solide-123' },
    })
    const buyerToken = regBuyer.json().token as string
    check('1. Register ACHETEUR → 201 + JWT', regBuyer.statusCode === 201 && !!buyerToken, `HTTP ${regBuyer.statusCode}`)

    const regTraveler = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: 'smoke-traveler@waylo.test', password: 'motdepasse-solide-456' },
    })
    const travelerToken = regTraveler.json().token as string
    check('1. Register VOYAGEUR → 201 + JWT', regTraveler.statusCode === 201 && !!travelerToken, `HTTP ${regTraveler.statusCode}`)

    // Voyageur : compte Connect + KYC vérifié (aucune route HTTP d'onboarding —
    // prérequis légitime de la libération, posé en DB). Sub lu via /me.
    const meTraveler = await app.inject({ method: 'GET', url: '/api/auth/me', headers: bearer(travelerToken) })
    const travelerId = meTraveler.json().id as string
    await prisma.user.update({
      where: { id: travelerId },
      data: { stripeAccountId: 'acct_smoke_traveler', kycStatus: 'VERIFIED' },
    })
    check('1b. Voyageur KYC VERIFIED + compte Connect (DB)', true)

    // 2) Création mission (acheteur).
    const create = await app.inject({
      method: 'POST',
      url: '/api/missions',
      headers: bearer(buyerToken),
      payload: {
        targetProduct: 'Théière en fonte (édition Kyoto)',
        budgetCents: BUDGET_CENTS,
        commissionCents: COMMISSION_CENTS,
        destination: 'Kyoto',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      },
    })
    const missionId = create.json().id as string
    check('2. POST /missions → 201 CREATED', create.statusCode === 201 && create.json().status === 'CREATED', `status=${create.json().status}`)

    // 3) Financement T0 (acheteur) → FUNDED + EscrowTransaction HELD.
    const intent = await app.inject({ method: 'POST', url: `/api/missions/${missionId}/intent`, headers: bearer(buyerToken) })
    check('3. POST /:id/intent → 200 (PaymentIntent + escrow)', intent.statusCode === 200, `HTTP ${intent.statusCode} amount=${intent.json().amountCents}`)
    check('3. Mission → FUNDED', (await missionStatus(missionId)) === 'FUNDED')
    const escrowAfterFund = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId } })
    check('3. Escrow HELD, capturedAmountCents=0, limit=budget', escrowAfterFund.status === 'HELD' && escrowAfterFund.capturedAmountCents === 0 && escrowAfterFund.spendingLimitCents === BUDGET_CENTS)

    // 4) Matchmaking (voyageur) → MATCHED.
    const match = await app.inject({ method: 'POST', url: `/api/missions/${missionId}/match`, headers: bearer(travelerToken) })
    check('4. POST /:id/match → 200 MATCHED', match.statusCode === 200 && (await missionStatus(missionId)) === 'MATCHED', `HTTP ${match.statusCode}`)

    // 5) Départ voyage (voyageur) → IN_PROGRESS.
    const start = await app.inject({ method: 'POST', url: `/api/missions/${missionId}/start-travel`, headers: bearer(travelerToken) })
    check('5. POST /:id/start-travel → 200 IN_PROGRESS', start.statusCode === 200 && (await missionStatus(missionId)) === 'IN_PROGRESS', `HTTP ${start.statusCode}`)

    // 6) Dépôt de reçu (voyageur) → AWAITING_VALIDATION + reçu scellé.
    const receipt = await app.inject({
      method: 'POST',
      url: `/api/missions/${missionId}/submit-receipt`,
      headers: bearer(travelerToken),
      payload: { urlRecu: 'https://receipts.waylo.test/smoke-abc.jpg', purchaseAmountCents: RECEIPT_CENTS },
    })
    check('6. POST /:id/submit-receipt → 201 (reçu scellé)', receipt.statusCode === 201 && receipt.json().totalTtcCents === RECEIPT_CENTS, `HTTP ${receipt.statusCode}`)
    check('6. Reçu scellé serveur (sha256 + sealedAt)', !!receipt.json().sha256Server && !!receipt.json().sealedAt)
    check('6. Mission → AWAITING_VALIDATION', (await missionStatus(missionId)) === 'AWAITING_VALIDATION')

    // 7) Validation humaine (acheteur) → capture → VALIDATED (transitoire).
    const validate = await app.inject({ method: 'POST', url: `/api/missions/${missionId}/validate`, headers: bearer(buyerToken) })
    check('7. POST /:id/validate → 200 VALIDATED', validate.statusCode === 200 && validate.json().status === 'VALIDATED', `HTTP ${validate.statusCode}`)

    // 7b) Webhook payment_intent.succeeded SIGNÉ → libération RELEASED.
    const payload = JSON.stringify({
      id: 'evt_smoke_capture',
      object: 'event',
      type: 'payment_intent.succeeded',
      data: { object: { id: `pi_${missionId}`, object: 'payment_intent', amount_received: AUTHORIZED_CENTS } },
    })
    const webhook = await app.inject({
      method: 'POST',
      url: '/api/stripe/webhook',
      payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSigner.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      },
    })
    check('7b. Webhook payment_intent.succeeded → 200 handled', webhook.statusCode === 200 && webhook.json().handled === true, `HTTP ${webhook.statusCode}`)
    check('7b. Mission → RELEASED', (await missionStatus(missionId)) === 'RELEASED')

    // État comptable final.
    const escrow = await prisma.escrowTransaction.findUniqueOrThrow({ where: { missionId }, include: { ledgerEntries: true, transfers: true } })
    const ledger: Record<string, number> = Object.fromEntries(escrow.ledgerEntries.map(l => [l.type, l.amountCents]))
    check(`FIN. Escrow RELEASED, capturé = ${AUTHORIZED_CENTS}`, escrow.status === 'RELEASED' && escrow.capturedAmountCents === AUTHORIZED_CENTS)
    check(`FIN. Ledger CAPTURE=${AUTHORIZED_CENTS}`, ledger.CAPTURE === AUTHORIZED_CENTS)
    check(`FIN. Ledger PAYOUT=${AUTHORIZED_CENTS - COMMISSION_CENTS} (voyageur)`, ledger.PAYOUT === AUTHORIZED_CENTS - COMMISSION_CENTS)
    check(`FIN. Ledger COMMISSION=${COMMISSION_CENTS} (plateforme)`, ledger.COMMISSION === COMMISSION_CENTS)
    check('FIN. Invariant Σ(PAYOUT+COMMISSION) == Σ(CAPTURE)', (ledger.PAYOUT ?? 0) + (ledger.COMMISSION ?? 0) === (ledger.CAPTURE ?? 0))
    check('FIN. TransferOutbox PENDING (1) pour versement voyageur', escrow.transfers.length === 1 && escrow.transfers[0]?.status === 'PENDING' && escrow.transfers[0]?.amountCents === AUTHORIZED_CENTS - COMMISSION_CENTS)

    console.log('\n=== ÉTAT FINAL ===')
    console.log(JSON.stringify({
      mission: await missionStatus(missionId),
      escrow: { status: escrow.status, capturedAmountCents: escrow.capturedAmountCents, spendingLimitCents: escrow.spendingLimitCents },
      ledgerCents: ledger,
      transferOutbox: { count: escrow.transfers.length, status: escrow.transfers[0]?.status, amountCents: escrow.transfers[0]?.amountCents, destination: escrow.transfers[0]?.destinationAccountId },
    }, null, 2))

    await purge()
    console.log('\nNettoyage waylo_test : OK')
    console.log(failures === 0 ? '\n✅ SMOKE E2E : TOUTES LES TRANSITIONS OK' : `\n❌ SMOKE E2E : ${failures} contrôle(s) en échec`)
    return failures === 0 ? 0 : 1
  } finally {
    await app.close()
    await prisma.$disconnect()
  }
}

main()
  .then(code => process.exit(code))
  .catch((err: unknown) => {
    console.error('\n💥 SMOKE E2E — exception :', err)
    process.exit(1)
  })
