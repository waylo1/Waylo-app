import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient, User } from '../generated/prisma'
import { resetDb } from '../../tests/helpers/db-reset'

/**
 * Arbitrage HUMAIN de la preuve de livraison —
 * PATCH /api/admin/missions/:id/delivery-proof.
 *
 * Réservé aux admins (`isRequestAdmin`). Pose `Mission.deliveryProofStatus`
 * (VALIDATED | REJECTED) et trace l'acteur (`AdminAuditLog` actor=ADMIN, adminId).
 * VALIDATED = preuve acceptée → contestation facturable (source de vérité lue par
 * disputeResolutionWorker). Atomique (service `updateDeliveryProof`).
 *
 * (1) admin VALIDATED → 200 + DB à jour + AdminAuditLog avec adminId correct ;
 * (2) admin REJECTED → 200 + DB à jour ;
 * (3) non-admin (buyer) → 403 ; non authentifié → 401 ; mission intacte ;
 * (4) mission absente → 404 ; status invalide (PENDING / inconnu) → 400 ; mission intacte.
 *
 * Prérequis : DATABASE_URL → base dédiée waylo_test.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

describe('Arbitrage preuve de livraison — PATCH /api/admin/missions/:id/delivery-proof', () => {
  let app: FastifyInstance
  let prisma: PrismaClient
  let admin: User
  let buyer: User
  let adminToken: string
  let buyerToken: string

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()
  })

  beforeEach(async () => {
    await resetDb(prisma)
    admin = await prisma.user.create({ data: { email: 'admin-dp@test.waylo', isAdmin: true } })
    buyer = await prisma.user.create({ data: { email: 'buyer-dp@test.waylo' } })
    adminToken = app.jwt.sign({ sub: admin.id })
    buyerToken = app.jwt.sign({ sub: buyer.id })
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
  const patch = (missionId: string, body: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'PATCH',
      url: `/api/admin/missions/${missionId}/delivery-proof`,
      headers,
      payload: body as object,
    })

  /** Mission au statut IN_DISPUTE, deliveryProofStatus PENDING (défaut). */
  async function seedMission(): Promise<string> {
    const mission = await prisma.mission.create({
      data: {
        buyerId: buyer.id,
        status: 'IN_DISPUTE',
        targetProduct: 'Article contesté',
        budgetCents: 10_000,
        commissionCents: 1_500,
        destination: 'Tokyo',
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      },
    })
    return mission.id
  }

  it('(1) admin VALIDATED → 200 + deliveryProofStatus VALIDATED + AdminAuditLog adminId correct', async () => {
    const missionId = await seedMission()

    const res = await patch(missionId, { status: 'VALIDATED' }, bearer(adminToken))

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ id: missionId, deliveryProofStatus: 'VALIDATED' })

    // DB à jour.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.deliveryProofStatus).toBe('VALIDATED')

    // Audit tracé : action dédiée, acteur HUMAIN (adminId renseigné, actor=ADMIN).
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { missionId, action: 'MISSION_DELIVERY_PROOF_UPDATED' },
    })
    expect(audit.adminId).toBe(admin.id)
    expect(audit.actor).toBe('ADMIN')
  })

  it('(2) admin REJECTED → 200 + deliveryProofStatus REJECTED', async () => {
    const missionId = await seedMission()

    const res = await patch(missionId, { status: 'REJECTED' }, bearer(adminToken))

    expect(res.statusCode).toBe(200)
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.deliveryProofStatus).toBe('REJECTED')
  })

  it('(3) non-admin → 403 ; non authentifié → 401 ; mission intacte + aucun audit', async () => {
    const missionId = await seedMission()

    const byBuyer = await patch(missionId, { status: 'VALIDATED' }, bearer(buyerToken))
    expect(byBuyer.statusCode).toBe(403)
    expect(byBuyer.json()).toEqual({ error: 'FORBIDDEN' })

    const unauth = await patch(missionId, { status: 'VALIDATED' })
    expect(unauth.statusCode).toBe(401)

    // Aucun effet : statut inchangé, aucun log d'arbitrage.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.deliveryProofStatus).toBe('PENDING')
    expect(
      await prisma.adminAuditLog.count({ where: { missionId, action: 'MISSION_DELIVERY_PROOF_UPDATED' } }),
    ).toBe(0)
  })

  it('(4) mission absente → 404 ; status invalide → 400 ; mission intacte', async () => {
    // Mission absente → 404 (fail-closed), aucun audit créé.
    const absent = await patch('mission_inexistante', { status: 'VALIDATED' }, bearer(adminToken))
    expect(absent.statusCode).toBe(404)
    expect(absent.json()).toEqual({ error: 'MISSION_NOT_FOUND' })
    expect(await prisma.adminAuditLog.count()).toBe(0)

    // status = PENDING (hors enum d'arbitrage) → 400 INVALID_INPUT.
    const missionId = await seedMission()
    const pending = await patch(missionId, { status: 'PENDING' }, bearer(adminToken))
    expect(pending.statusCode).toBe(400)
    expect(pending.json()).toEqual({ error: 'INVALID_INPUT' })

    // status inconnu → 400.
    const garbage = await patch(missionId, { status: 'WHATEVER' }, bearer(adminToken))
    expect(garbage.statusCode).toBe(400)

    // Body sans status → 400.
    const empty = await patch(missionId, {}, bearer(adminToken))
    expect(empty.statusCode).toBe(400)

    // Aucune mutation : la mission reste PENDING.
    const mission = await prisma.mission.findUniqueOrThrow({ where: { id: missionId } })
    expect(mission.deliveryProofStatus).toBe('PENDING')
  })
})
