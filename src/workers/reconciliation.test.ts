import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { OpsAlert } from '../alerts'
import type { StripeReconciliationClient } from './reconciliation'

/**
 * Reconciliation — section 7 : timeout collecte acheteur (DEPOSITED > 5 jours).
 * L'acheteur n'a pas confirmé la collecte : le worker libère automatiquement le
 * séquestre via le chemin financier existant (capture hors tx → VALIDATED → webhook).
 *
 * (A) DEPOSITED depuis 6 j + escrow HELD → capture `timeout_collection_<id>` + VALIDATED ;
 * (B) DEPOSITED récent (1 j) → non capturé, reste DEPOSITED (seuil 5 j non franchi) ;
 * (C) capture Stripe échoue → alerte CRITIQUE `COLLECTION_TIMEOUT_CAPTURE_FAILED`, reste DEPOSITED ;
 * (D) escrow non HELD (déjà RELEASED) → non capturé (rien à libérer).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const DAY_MS = 24 * 3600 * 1000

describe('Reconciliation — timeout collecte acheteur (DEPOSITED > 5 j)', () => {
  let prisma: PrismaClient
  let buyerId: string
  let travelerId: string

  const captureCalls: Array<{ id: string; key: string }> = []
  let captureShouldFail = false

  const fakeStripe: StripeReconciliationClient = {
    transfers: { retrieve: async () => ({}) },
    paymentIntents: {
      retrieve: async () => ({ amount_received: 0 }),
      cancel: async (id: string) => ({ id }),
      capture: async (id: string, _params, options) => {
        if (captureShouldFail) throw new Error('card_expired')
        captureCalls.push({ id, key: options.idempotencyKey })
        return { id }
      },
    },
  }

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
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
    const buyer = await prisma.user.create({ data: { email: 'buyer-recon@test.waylo' } })
    const traveler = await prisma.user.create({ data: { email: 'traveler-recon@test.waylo' } })
    buyerId = buyer.id
    travelerId = traveler.id
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  beforeEach(async () => {
    captureCalls.length = 0
    captureShouldFail = false
    await prisma.escrowTransaction.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.mission.deleteMany()
  })

  /** Mission DEPOSITED + escrow ; dropoffAt = il y a `ageDays` jours. */
  async function seedDeposited(ageDays: number, escrowStatus = 'HELD') {
    const mission = await prisma.mission.create({
      data: {
        buyerId,
        travelerId,
        status: 'DEPOSITED' as never,
        targetProduct: 'Colis recon',
        budgetCents: 50_000,
        commissionCents: 5_000,
        destination: 'Nice',
        dropoffReceiptUrl: 'https://proofs.waylo.app/d.pdf',
        dropoffAt: new Date(Date.now() - ageDays * DAY_MS),
        expiresAt: new Date(Date.now() + 30 * DAY_MS),
      },
    })
    await prisma.escrowTransaction.create({
      data: {
        missionId: mission.id,
        stripePaymentIntentId: `pi_recon_${mission.id}`,
        status: escrowStatus as never,
        spendingLimitCents: 50_000,
        idempotencyKey: `escrow_fund_${mission.id}`,
      },
    })
    return mission
  }

  it('(A) DEPOSITED > 5 j + escrow HELD → capture timeout_collection_<id> + VALIDATED', async () => {
    const { runReconciliation } = await import('./reconciliation')
    const mission = await seedDeposited(6)

    await runReconciliation({ prisma, stripe: fakeStripe, onAlert: () => {} })

    expect(captureCalls).toEqual([
      { id: `pi_recon_${mission.id}`, key: `timeout_collection_${mission.id}` },
    ])
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('VALIDATED')
  })

  it('(B) DEPOSITED récent (< 5 j) → non capturé, reste DEPOSITED', async () => {
    const { runReconciliation } = await import('./reconciliation')
    const mission = await seedDeposited(1)

    await runReconciliation({ prisma, stripe: fakeStripe, onAlert: () => {} })

    expect(captureCalls).toHaveLength(0)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DEPOSITED')
  })

  it('(C) capture Stripe échoue → alerte critique COLLECTION_TIMEOUT_CAPTURE_FAILED, reste DEPOSITED', async () => {
    captureShouldFail = true
    const { runReconciliation } = await import('./reconciliation')
    const mission = await seedDeposited(6)

    const collected: OpsAlert[] = []
    await runReconciliation({ prisma, stripe: fakeStripe, onAlert: a => collected.push(a) })

    const fail = collected.find(a => a.code === 'COLLECTION_TIMEOUT_CAPTURE_FAILED')
    expect(fail).toBeTruthy()
    expect(fail?.severity).toBe('critical')
    expect(fail?.details.missionId).toBe(mission.id)

    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DEPOSITED') // pas de transition si la capture échoue
  })

  it('(D) escrow non HELD (déjà RELEASED) → non capturé', async () => {
    const { runReconciliation } = await import('./reconciliation')
    const mission = await seedDeposited(6, 'RELEASED')

    await runReconciliation({ prisma, stripe: fakeStripe, onAlert: () => {} })

    expect(captureCalls).toHaveLength(0)
    const db = await prisma.mission.findUniqueOrThrow({ where: { id: mission.id } })
    expect(db.status).toBe('DEPOSITED')
  })
})
