import { FastifyPluginAsync, FastifyRequest } from 'fastify'
import argon2 from 'argon2'
import { prisma } from '../db'
import { Prisma } from '../generated/prisma'
import { isRateLimited, maskIp } from '../rate-limit'
import { clearAuthCookie, serializeAuthCookie } from './cookie'
import { AppError } from '../errors/app.error'
import { requestMagicLink, verifyMagicLink, noopTransport } from './auth.service'
// SSOT : forme du corps login/register partagée avec le mobile (@waylo/shared).
import type { LoginRequest } from '@waylo/shared'

/** Anti-brute-force : 429 au-delà du seuil, clé par route + IP + email. */
const authRateLimit =
  (name: string) => async (req: FastifyRequest): Promise<void> => {
    const email = ((req.body as { email?: string } | undefined)?.email ?? '').toLowerCase()
    if (await isRateLimited(`${name}:${maskIp(req.ip)}:${email}`)) {
      throw new AppError('RATE_LIMITED', 429)
    }
  }

/**
 * Authentification minimale : register / login / me.
 * - argon2 (jamais de hash maison, jamais de clair) ;
 * - JWT { sub: userId } — identité seule. Pas de rôle de compte (« acheteur »/
 *   « voyageur » est contextuel, décidé par mission via l'API missions) ;
 * - login : échec GÉNÉRIQUE (INVALID_CREDENTIALS) — ne révèle pas si l'email
 *   existe, et vérifie un hash factice quand il n'existe pas (pas d'oracle
 *   de timing) ;
 * - validation d'entrée par schéma de route Fastify (pattern email : ajv de
 *   Fastify 4 n'embarque pas les formats — pas de dépendance en plus).
 */

const TOKEN_TTL = '12h'
const MAGIC_LINK_JWT_TTL = '24h'
const PASSWORD_MIN_LENGTH = 8
// Volontairement permissif (présence de @ et d'un point dans le domaine) :
// la vraie preuve de validité sera la vérification d'adresse, pas la regex.
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

// Register : validation stricte (format email + politique de longueur).
const registerBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    password: { type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: 128 },
  },
} as const

// Login : validation permissive (présence seule) — toute combinaison invalide
// finit en 401 générique, jamais en 400 qui révélerait la politique de mdp.
const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', maxLength: 254 },
    password: { type: 'string', maxLength: 128 },
  },
} as const

const requestLinkBodySchema = {
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
  },
} as const

const verifyBodySchema = {
  type: 'object',
  required: ['email', 'token'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', maxLength: 254 },
    token: { type: 'string', minLength: 6, maxLength: 6, pattern: '^[0-9]{6}$' },
  },
} as const

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

const authRoute: FastifyPluginAsync = async app => {
  // Hash factice pour les emails inconnus : le login fait TOUJOURS une
  // vérification argon2, que le compte existe ou non.
  const dummyHash = await argon2.hash('waylo-dummy-password-timing-shield')

  app.post('/register', { schema: { body: registerBodySchema }, preHandler: authRateLimit('register') }, async (req, reply) => {
    const { email, password } = req.body as LoginRequest
    const passwordHash = await argon2.hash(password)
    try {
      const user = await prisma.user.create({
        data: { email: email.toLowerCase(), passwordHash },
      })
      const token = app.jwt.sign({ sub: user.id }, { expiresIn: TOKEN_TTL })
      // Cookie HttpOnly émis ; { token } conservé pour compat (clients non-navigateur).
      return await reply
        .header('set-cookie', serializeAuthCookie(token))
        .code(201)
        .send({ token })
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError('EMAIL_ALREADY_REGISTERED', 409)
      }
      throw err
    }
  })

  app.post('/login', { schema: { body: loginBodySchema }, preHandler: authRateLimit('login') }, async (req, reply) => {
    const { email, password } = req.body as LoginRequest
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    // Toujours un verify (hash réel ou factice) AVANT de décider — pas
    // d'early-return qui trahirait l'existence du compte par le timing.
    const passwordValid = await argon2.verify(user?.passwordHash ?? dummyHash, password)
    if (!user?.passwordHash || !passwordValid) {
      throw new AppError('INVALID_CREDENTIALS', 401)
    }
    const token = app.jwt.sign({ sub: user.id }, { expiresIn: TOKEN_TTL })
    return reply.header('set-cookie', serializeAuthCookie(token)).code(200).send({ token })
  })

  // POST /auth/refresh — session glissante : un jeton VALIDE (cookie ou Bearer)
  // est ré-émis (cookie HttpOnly rafraîchi). 401 si la session est expirée.
  app.post('/refresh', { preHandler: app.authenticate }, async (req, reply) => {
    const token = app.jwt.sign({ sub: req.user.sub }, { expiresIn: TOKEN_TTL })
    return reply.header('set-cookie', serializeAuthCookie(token)).code(200).send({ token })
  })

  // POST /auth/logout — purge le cookie d'auth (pas d'auth requise : permet de
  // nettoyer une session même expirée).
  app.post('/logout', async (_req, reply) => {
    return reply.header('set-cookie', clearAuthCookie()).code(200).send({ ok: true })
  })

  // POST /auth/request-link — envoie un code 6 chiffres par email (MVP : no-op transport).
  app.post('/request-link', { schema: { body: requestLinkBodySchema }, preHandler: authRateLimit('request-link') }, async (req, reply) => {
    const { email } = req.body as { email: string }
    await requestMagicLink(email.toLowerCase(), noopTransport)
    return reply.code(200).send({ ok: true })
  })

  // POST /auth/verify — valide le code et émet un JWT 24 h.
  app.post('/verify', { schema: { body: verifyBodySchema }, preHandler: authRateLimit('verify') }, async (req, reply) => {
    const { email, token } = req.body as { email: string; token: string }
    const userId = await verifyMagicLink(email.toLowerCase(), token)
    const jwtToken = app.jwt.sign({ sub: userId }, { expiresIn: MAGIC_LINK_JWT_TTL })
    return reply.header('set-cookie', serializeAuthCookie(jwtToken)).code(200).send({ token: jwtToken })
  })

  // Route protégée : valide le middleware ET sert au frontend. Relit la DB :
  // KYC à jour, et un compte supprimé est immédiatement déconnecté.
  app.get('/me', { preHandler: app.authenticate }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { id: true, email: true, kycStatus: true, createdAt: true },
    })
    if (!user) {
      throw new AppError('UNAUTHORIZED', 401)
    }
    return reply.send(user)
  })
}

export default authRoute
