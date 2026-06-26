import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'
import type { NotificationPayload, NotificationSink } from './notification.service'
import { notifyActor } from './notification.service'
import { randomUUID } from 'node:crypto'

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

const nextId = (): string => `cmtest${randomUUID().replace(/-/g, '')}`

// ---------------------------------------------------------------------------
// [NOTIF-01] notification.service — notifyActor
// ---------------------------------------------------------------------------

describe('[NOTIF-01] notification.service — notifyActor', () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await resetDb(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('émission correcte : sink appelé avec payload whitelist', async () => {
    const missionId = nextId()
    const received: NotificationPayload[] = []
    const testSink: NotificationSink = {
      send: async (_recipientId, payload) => { received.push(payload) },
    }

    await notifyActor(
      'notif:mission-matched',
      missionId,
      'recipient-id-buyer',
      { event: 'notif:mission-matched', missionId, targetProduct: 'Parfum Chanel', destination: 'Tokyo' },
      testSink,
    )

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      event: 'notif:mission-matched',
      missionId,
      targetProduct: 'Parfum Chanel',
      destination: 'Tokyo',
    })
  })

  it('idempotence : double-trigger même (alias, missionId) → sink appelé 1 seule fois', async () => {
    const missionId = nextId()
    let callCount = 0
    const testSink: NotificationSink = {
      send: async () => { callCount++ },
    }

    const args = [
      'notif:mission-matched',
      missionId,
      'r1',
      { event: 'notif:mission-matched', missionId, targetProduct: 'P', destination: 'D' },
      testSink,
    ] as const

    await notifyActor(...args)
    await notifyActor(...args)

    expect(callCount).toBe(1)
  })

  it('anti-fuite : payload ne contient aucun champ sensible', async () => {
    const missionId = nextId()
    const received: NotificationPayload[] = []
    const testSink: NotificationSink = {
      send: async (_rid, payload) => { received.push(payload) },
    }

    await notifyActor(
      'notif:anti-fuite',
      missionId,
      'r2',
      { event: 'notif:anti-fuite', missionId, targetProduct: 'Article test', destination: 'Paris' },
      testSink,
    )

    expect(received).toHaveLength(1)
    const p = received[0] as unknown as Record<string, unknown>
    expect(p).not.toHaveProperty('buyerId')
    expect(p).not.toHaveProperty('travelerId')
    expect(p).not.toHaveProperty('purchaseAmountCents')
    expect(p).not.toHaveProperty('deliveryProofHash')
    expect(p).not.toHaveProperty('saleSignature')
    expect(p).not.toHaveProperty('innerQrCodeHash')
    expect(p).not.toHaveProperty('dropOffAccessCode')
    expect(p).not.toHaveProperty('disputeReason')
  })
})
