import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { PrismaClient } from '../generated/prisma'

/**
 * Auth : register (succès, email pris, mot de passe court, email invalide),
 * login (succès, mauvais mot de passe, email inconnu → réponse GÉNÉRIQUE
 * identique), /me (token valide, absent, invalide, expiré).
 *
 * Prérequis : DATABASE_URL → base waylo_test (cf. webhook.idempotence.test.ts).
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_async'
process.env.STRIPE_ISSUING_WEBHOOK_SECRET = 'whsec_test_issuing'
process.env.JWT_SECRET = 'jwt_test_secret_waylo'

const EMAIL = 'buyer-auth@test.waylo'
const PASSWORD = 'correct-horse-battery'

describe('Auth — register / login / me', () => {
  let app: FastifyInstance
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    app = await (await import('../app')).buildApp()

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
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
  })

  const register = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/auth/register', payload: body })
  const login = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: body })
  const me = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/api/auth/me', headers })

  it('register : succès → 201 + JWT utilisable sur /me, sans rôle de compte', async () => {
    const res = await register({ email: EMAIL, password: PASSWORD })
    expect(res.statusCode).toBe(201)
    const { token } = res.json() as { token: string }
    expect(token).toBeTruthy()

    // Le hash est en DB, jamais le mot de passe en clair.
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })
    expect(user.passwordHash).toMatch(/^\$argon2/)
    expect(user.passwordHash).not.toContain(PASSWORD)

    const whoami = await me({ authorization: `Bearer ${token}` })
    expect(whoami.statusCode).toBe(200)
    const body = whoami.json()
    expect(body).toMatchObject({ id: user.id, email: EMAIL })
    // /me ne renvoie aucun rôle de compte (rôles contextuels par mission).
    expect(body).not.toHaveProperty('role')
  })

  it('register : email déjà pris → 409, sans écraser le compte', async () => {
    const res = await register({ email: EMAIL, password: 'another-password' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'EMAIL_ALREADY_REGISTERED' })
    expect(await prisma.user.count({ where: { email: EMAIL } })).toBe(1)
  })

  it('register : mot de passe trop court → 400', async () => {
    const res = await register({ email: 'short@test.waylo', password: 'court' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  it('register : email invalide → 400', async () => {
    const res = await register({ email: 'pas-un-email', password: PASSWORD })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'INVALID_INPUT' })
  })

  it('register : un champ role parasite est ignoré (rôle non collecté), compte normal créé', async () => {
    // Fastify (ajv removeAdditional) retire les props hors schéma : le `role`
    // envoyé par un vieux client est silencieusement ignoré, pas stocké.
    const res = await register({ email: 'extra@test.waylo', password: PASSWORD, role: 'BUYER' })
    expect(res.statusCode).toBe(201)
    const { token } = res.json() as { token: string }
    const whoami = await me({ authorization: `Bearer ${token}` })
    expect(whoami.statusCode).toBe(200)
    expect(whoami.json()).not.toHaveProperty('role')
  })

  it('login : succès → 200 + JWT utilisable', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD })
    expect(res.statusCode).toBe(200)
    const { token } = res.json() as { token: string }
    const whoami = await me({ authorization: `Bearer ${token}` })
    expect(whoami.statusCode).toBe(200)
  })

  it('login : mauvais mot de passe et email inconnu → MÊME réponse générique', async () => {
    const wrongPassword = await login({ email: EMAIL, password: 'wrong-password-123' })
    const unknownEmail = await login({ email: 'inconnu@test.waylo', password: PASSWORD })

    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownEmail.statusCode).toBe(401)
    // Indistinguables : aucun indice sur l'existence du compte.
    expect(wrongPassword.json()).toEqual({ error: 'INVALID_CREDENTIALS' })
    expect(unknownEmail.json()).toEqual({ error: 'INVALID_CREDENTIALS' })
  })

  it('me : token absent → 401', async () => {
    const res = await me()
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' })
  })

  it('me : token invalide → 401', async () => {
    const res = await me({ authorization: 'Bearer pas.un.jwt' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' })
  })

  it('me : token expiré → 401', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } })
    // exp == iat (1 ms arrondi à la seconde) : déjà expiré à la vérification.
    const expired = app.jwt.sign({ sub: user.id }, { expiresIn: '1ms' })
    const res = await me({ authorization: `Bearer ${expired}` })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED' })
  })
})
