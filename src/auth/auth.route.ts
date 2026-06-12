import { FastifyPluginAsync } from 'fastify'
import argon2 from 'argon2'
import { prisma } from '../db'
import { Prisma, Role } from '../generated/prisma'

/**
 * Authentification minimale : register / login / me.
 * - argon2 (jamais de hash maison, jamais de clair) ;
 * - JWT { sub: userId, role }, expiration TOKEN_TTL ;
 * - login : échec GÉNÉRIQUE (INVALID_CREDENTIALS) — ne révèle pas si l'email
 *   existe, et vérifie un hash factice quand il n'existe pas (pas d'oracle
 *   de timing) ;
 * - validation d'entrée par schéma de route Fastify (pattern email : ajv de
 *   Fastify 4 n'embarque pas les formats — pas de dépendance en plus).
 */

const TOKEN_TTL = '12h'
const PASSWORD_MIN_LENGTH = 8
// Volontairement permissif (présence de @ et d'un point dans le domaine) :
// la vraie preuve de validité sera la vérification d'adresse, pas la regex.
const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'

interface RegisterBody {
  email: string
  password: string
  role: Role
}

interface LoginBody {
  email: string
  password: string
}

const registerBodySchema = {
  type: 'object',
  required: ['email', 'password', 'role'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', pattern: EMAIL_PATTERN, maxLength: 254 },
    password: { type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: 128 },
    role: { type: 'string', enum: [Role.BUYER, Role.TRAVELER] }, // miroir exact de l'enum Prisma
  },
} as const

const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', maxLength: 254 },
    password: { type: 'string', maxLength: 128 },
  },
} as const

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

const authRoute: FastifyPluginAsync = async app => {
  // Erreurs de validation au format maison { error: SNAKE_CASE } (encapsulé).
  app.setErrorHandler((err, req, reply) => {
    if (err.validation) {
      return reply.code(400).send({ error: 'INVALID_INPUT' })
    }
    req.log.error({ err }, 'auth route error')
    return reply.code(500).send({ error: 'INTERNAL_ERROR' })
  })

  // Hash factice pour les emails inconnus : le login fait TOUJOURS une
  // vérification argon2, que le compte existe ou non.
  const dummyHash = await argon2.hash('waylo-dummy-password-timing-shield')

  app.post('/register', { schema: { body: registerBodySchema } }, async (req, reply) => {
    const { email, password, role } = req.body as RegisterBody
    const passwordHash = await argon2.hash(password)
    try {
      const user = await prisma.user.create({
        data: { email: email.toLowerCase(), role, passwordHash },
      })
      const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: TOKEN_TTL })
      return await reply.code(201).send({ token })
    } catch (err) {
      if (isUniqueViolation(err)) {
        return reply.code(409).send({ error: 'EMAIL_ALREADY_REGISTERED' })
      }
      throw err
    }
  })

  app.post('/login', { schema: { body: loginBodySchema } }, async (req, reply) => {
    const { email, password } = req.body as LoginBody
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } })
    // Toujours un verify (hash réel ou factice) AVANT de décider — pas
    // d'early-return qui trahirait l'existence du compte par le timing.
    const passwordValid = await argon2.verify(user?.passwordHash ?? dummyHash, password)
    if (!user?.passwordHash || !passwordValid) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS' }) // générique, voulu
    }
    const token = app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: TOKEN_TTL })
    return reply.code(200).send({ token })
  })

  // Route protégée : valide le middleware ET sert au frontend. Relit la DB :
  // rôle/KYC à jour, et un compte supprimé est immédiatement déconnecté.
  app.get('/me', { preHandler: app.authenticate }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { id: true, email: true, role: true, kycStatus: true, createdAt: true },
    })
    if (!user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' })
    }
    return user
  })
}

export default authRoute
