import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from './generated/prisma'

/**
 * Durcissement des alertes :
 * (1) PAYOUT_NOT_SETTLED — un PAYOUT sous la fenêtre de grâce (60 min) est un
 *     transitoire normal → silence ; le même état antidaté au-delà → alerte.
 * (2) AUTHORIZATION_WITHOUT_CAPTURE — idem avec authWithoutCaptureHours (24 h).
 * (3) Un code critical atteint le sink critique persistant (NDJSON), pas
 *     seulement stderr ; un warn n'y va pas.
 *
 * Prérequis : DATABASE_URL → base waylo_test (cf. webhook.idempotence.test.ts).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

// Posé AVANT tout import (même transitif) de src/alerts.ts : le chemin du sink
// critique est lu au chargement du module.
const CRITICAL_FILE = join(tmpdir(), `waylo-test-critical-${process.pid}.ndjson`)
process.env.WAYLO_CRITICAL_ALERTS_FILE = CRITICAL_FILE

const BUDGET_CENTS = 10_000
const COMMISSION_CENTS = 1_500
const PAYOUT_CENTS = BUDGET_CENTS - COMMISSION_CENTS

describe('Fenêtres de grâce & sink critique', () => {
  let prisma: PrismaClient
  let escrowFreshId: string
  let escrowOldId: string

  beforeAll(async () => {
    prisma = (await import('./db')).prisma

    await prisma.transferOutbox.deleteMany()
    await prisma.ledgerEntry.deleteMany()
    await prisma.issuingAuthorizationLog.deleteMany()
    await prisma.receipt.deleteMany()
    await prisma.substitutionRequest.deleteMany()
    await prisma.escrowTransaction.deleteMany()
    await prisma.processedStripeEvent.deleteMany()
    await prisma.mission.deleteMany()
    await prisma.user.deleteMany()

    const buyer = await prisma.user.create({
      data: { email: 'buyer-grace@test.waylo', kycStatus: 'VERIFIED' },
    })
    const traveler = await prisma.user.create({
      data: {
        email: 'traveler-grace@test.waylo',
        kycStatus: 'VERIFIED',
        stripeAccountId: 'acct_test_grace',
      },
    })

    // Deux escrows RELEASED au ledger équilibré, AUCUN transfert réglé : seul
    // l'âge de la ligne PAYOUT diffère (frais vs antidaté au-delà de la grâce).
    const seedEscrow = async (suffix: string, payoutCreatedAt: Date): Promise<string> => {
      const mission = await prisma.mission.create({
        data: {
          buyerId: buyer.id,
          travelerId: traveler.id,
          status: 'RELEASED',
          targetProduct: `Produit ${suffix}`,
          budgetCents: BUDGET_CENTS,
          commissionCents: COMMISSION_CENTS,
          destination: 'Séoul',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      })
      const escrow = await prisma.escrowTransaction.create({
        data: {
          missionId: mission.id,
          stripePaymentIntentId: `pi_grace_${suffix}`,
          capturedAmountCents: BUDGET_CENTS,
          status: 'RELEASED',
          spendingLimitCents: BUDGET_CENTS,
          idempotencyKey: `idem_grace_${suffix}`,
        },
      })
      await prisma.ledgerEntry.createMany({
        data: [
          { escrowId: escrow.id, type: 'CAPTURE', amountCents: BUDGET_CENTS, createdAt: payoutCreatedAt },
          { escrowId: escrow.id, type: 'PAYOUT', amountCents: PAYOUT_CENTS, createdAt: payoutCreatedAt },
          { escrowId: escrow.id, type: 'COMMISSION', amountCents: COMMISSION_CENTS, createdAt: payoutCreatedAt },
        ],
      })
      return escrow.id
    }

    escrowFreshId = await seedEscrow('fresh', new Date())
    escrowOldId = await seedEscrow('old', new Date(Date.now() - 2 * 3600 * 1000))
  })

  afterAll(async () => {
    await prisma.$disconnect()
    rmSync(CRITICAL_FILE, { force: true })
  })

  it('(1) PAYOUT_NOT_SETTLED : sous la grâce → silence, au-delà → alerte', async () => {
    const { runReconciliation } = await import('./workers/reconciliation')

    const alerts = await runReconciliation({ prisma, onAlert: () => {} })
    const notSettled = alerts.filter(a => a.code === 'PAYOUT_NOT_SETTLED')

    // UNE seule alerte : l'escrow au PAYOUT antidaté. Le frais est silencieux.
    expect(notSettled).toHaveLength(1)
    expect(notSettled[0]?.details).toMatchObject({ escrowId: escrowOldId })
    expect(notSettled.some(a => a.details['escrowId'] === escrowFreshId)).toBe(false)
    // Aucun faux positif comptable sur ces escrows équilibrés.
    expect(alerts.filter(a => a.code === 'LEDGER_INVARIANT_BROKEN')).toHaveLength(0)

    // Grâce resserrée à 0 min : le même état frais devient alertable —
    // la fenêtre est bien la seule chose qui le protégeait.
    const strict = await runReconciliation({
      prisma,
      onAlert: () => {},
      payoutSettleGraceMinutes: 0,
    })
    const strictNotSettled = strict.filter(a => a.code === 'PAYOUT_NOT_SETTLED')
    expect(strictNotSettled).toHaveLength(2)
  })

  it('(2) AUTHORIZATION_WITHOUT_CAPTURE : récente → silence, au-delà du seuil → alerte', async () => {
    const { runReconciliation } = await import('./workers/reconciliation')

    await prisma.issuingAuthorizationLog.createMany({
      data: [
        {
          stripeAuthorizationId: 'iauth_grace_fresh',
          requestedAmountCents: 4_000,
          decision: 'APPROVED',
          reason: 'WITHIN_BUDGET',
          createdAt: new Date(), // sous le seuil de 24 h
        },
        {
          stripeAuthorizationId: 'iauth_grace_old',
          requestedAmountCents: 4_000,
          decision: 'APPROVED',
          reason: 'WITHIN_BUDGET',
          createdAt: new Date(Date.now() - 25 * 3600 * 1000), // au-delà
        },
      ],
    })

    const alerts = await runReconciliation({ prisma, onAlert: () => {} })
    const dangling = alerts.filter(a => a.code === 'AUTHORIZATION_WITHOUT_CAPTURE')
    expect(dangling).toHaveLength(1)
    expect(dangling[0]?.details).toMatchObject({ stripeAuthorizationId: 'iauth_grace_old' })
  })

  it('(3) critical et ops atteignent le sink NDJSON persistant, un warn non', async () => {
    const { safeEmit, toOpsAlert } = await import('./alerts')

    const critical = safeEmit(undefined, {
      code: 'LEDGER_INVARIANT_BROKEN',
      message: 'test sink critique',
      details: { escrowId: 'escrow_test_sink' },
    })
    expect(critical.severity).toBe('critical')

    const lines = readFileSync(CRITICAL_FILE, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      code: 'LEDGER_INVARIANT_BROKEN',
      severity: 'critical',
      details: { escrowId: 'escrow_test_sink' },
    })

    // Un warn passe par stderr structuré mais ne pollue PAS le sink durable.
    const warn = safeEmit(undefined, {
      code: 'PAYOUT_NOT_SETTLED',
      message: 'test warn',
      details: {},
    })
    expect(warn.severity).toBe('warn')
    expect(readFileSync(CRITICAL_FILE, 'utf8').trim().split('\n')).toHaveLength(1)

    // TRAVELER_ACCOUNT_MISSING = ops : fonds bloqués → durable, comme critical.
    const ops = safeEmit(undefined, {
      code: 'TRAVELER_ACCOUNT_MISSING',
      message: 'test sink ops',
      details: { escrowId: 'escrow_test_ops' },
    })
    expect(ops.severity).toBe('ops')
    const withOps = readFileSync(CRITICAL_FILE, 'utf8').trim().split('\n')
    expect(withOps).toHaveLength(2)
    expect(JSON.parse(withOps[1] as string)).toMatchObject({
      code: 'TRAVELER_ACCOUNT_MISSING',
      severity: 'ops',
    })

    // Un réconciliateur mort est un incident critique, pas un warn.
    expect(toOpsAlert({ code: 'RECONCILIATION_RUN_FAILED', message: '', details: {} }).severity)
      .toBe('critical')
  })

  it("(3 bis) sink custom défaillant : l'alerte critical retombe sur le sink NDJSON", async () => {
    const { safeEmit } = await import('./alerts')
    rmSync(CRITICAL_FILE, { force: true })

    safeEmit(
      () => {
        throw new Error('pager down')
      },
      { code: 'TRANSFER_ABANDONED', message: 'test fallback', details: {} },
    )

    expect(existsSync(CRITICAL_FILE)).toBe(true)
    const lines = readFileSync(CRITICAL_FILE, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      code: 'TRANSFER_ABANDONED',
      severity: 'critical',
    })

    // Même garantie de durabilité pour ops (fonds bloqués) sur sink défaillant.
    safeEmit(
      () => {
        throw new Error('pager down')
      },
      { code: 'TRAVELER_ACCOUNT_MISSING', message: 'test fallback ops', details: {} },
    )
    const withOps = readFileSync(CRITICAL_FILE, 'utf8').trim().split('\n')
    expect(withOps).toHaveLength(2)
    expect(JSON.parse(withOps[1] as string)).toMatchObject({
      code: 'TRAVELER_ACCOUNT_MISSING',
      severity: 'ops',
    })
  })
})
