import { prisma } from '../db'
import { runAlias } from '@waylo/shared/automation'
import { AppError } from '../errors/app.error'

const MAGIC_LINK_TTL_MS = 15 * 60 * 1_000 // 15 min
const MAX_ATTEMPTS = 5

export type MagicLinkTransport = (email: string, token: string) => Promise<void>

/** Transport no-op (MVP) — log console uniquement, aucune dépendance email. */
export const noopTransport: MagicLinkTransport = async (email, _token) => {
  console.log(`[magic-link] to=${email}`)
}

function generateToken(): string {
  return String(Math.floor(100_000 + Math.random() * 900_000))
}

/**
 * Génère un token 6 chiffres, stocke en DB (upsert), crée l'utilisateur si
 * inconnu (mode « pending » : passwordHash null), puis déclenche le transport
 * via l'alias Watchdog « email-send » (retry + timeout).
 */
export async function requestMagicLink(
  email: string,
  transport: MagicLinkTransport,
): Promise<void> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS)

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email },
  })

  await prisma.magicLink.upsert({
    where: { email },
    update: { token, expiresAt, attempts: 0 },
    create: { email, token, expiresAt },
  })

  await runAlias('email-send', () => transport(email, token), {
    idempotencyKey: `magic:${email}`,
  })
}

/**
 * Valide le token : vérifie l'expiration et la valeur. En cas d'échec,
 * incrémente le compteur de tentatives. En cas de succès, supprime le token
 * (consommation unique) et retourne l'id de l'utilisateur.
 */
export async function verifyMagicLink(email: string, token: string): Promise<string> {
  const link = await prisma.magicLink.findUnique({ where: { email } })

  if (!link) throw new AppError('MAGIC_LINK_INVALID', 401)
  if (link.attempts >= MAX_ATTEMPTS) throw new AppError('MAGIC_LINK_EXHAUSTED', 429)
  if (link.expiresAt < new Date()) throw new AppError('MAGIC_LINK_EXPIRED', 401)

  if (link.token !== token) {
    await prisma.magicLink.update({
      where: { email },
      data: { attempts: { increment: 1 } },
    })
    throw new AppError('MAGIC_LINK_INVALID', 401)
  }

  await prisma.magicLink.delete({ where: { email } })

  const user = await prisma.user.findUniqueOrThrow({ where: { email } })
  return user.id
}
