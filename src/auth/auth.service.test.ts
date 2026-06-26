import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { AppError } from '../errors/app.error'
import { requestMagicLink, verifyMagicLink } from './auth.service'
import { runAlias } from '@waylo/shared/automation'

/**
 * auth.service — requestMagicLink / verifyMagicLink
 *
 * runAlias est mocké : l'alias « email-send » n'a pas besoin d'être enregistré,
 * et le transport est toujours appelé (le mock délègue à `fn`).
 * La DB (waylo_test) est réelle : on vérifie les effets persistants.
 */

if (!process.env.DATABASE_URL?.includes('waylo_test')) {
  throw new Error('DATABASE_URL doit cibler la base waylo_test')
}

vi.mock('@waylo/shared/automation', async importOriginal => {
  const actual = await importOriginal<typeof import('@waylo/shared/automation')>()
  return {
    ...actual,
    runAlias: vi.fn(
      async (_name: string, fn: (key: string | undefined) => Promise<unknown>) => fn(undefined),
    ),
  }
})

const EMAIL = 'magic-svc@test.waylo'

describe('auth.service — requestMagicLink / verifyMagicLink', () => {
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = (await import('../db')).prisma
    await prisma.magicLink.deleteMany({ where: { email: EMAIL } })
    await prisma.user.deleteMany({ where: { email: EMAIL } })
  })

  afterAll(async () => {
    await prisma.magicLink.deleteMany({ where: { email: EMAIL } })
    await prisma.user.deleteMany({ where: { email: EMAIL } })
    await prisma.$disconnect()
  })

  it('[1] requestMagicLink appelle runAlias("email-send") et passe le token 6 chiffres au transport', async () => {
    const transport = vi.fn().mockResolvedValue(undefined)

    await requestMagicLink(EMAIL, transport)

    expect(runAlias).toHaveBeenCalledWith('email-send', expect.any(Function), expect.any(Object))
    expect(transport).toHaveBeenCalledOnce()
    const [calledEmail, calledToken] = transport.mock.calls[0] as [string, string]
    expect(calledEmail).toBe(EMAIL)
    expect(calledToken).toMatch(/^\d{6}$/)
  })

  it('[2] requestMagicLink crée un User pending (passwordHash null) si email inconnu', async () => {
    const user = await prisma.user.findUnique({ where: { email: EMAIL } })
    expect(user).not.toBeNull()
    expect(user?.passwordHash).toBeNull()
  })

  it('[3] verifyMagicLink — token valide retourne userId et consomme le lien', async () => {
    const transport = vi.fn().mockResolvedValue(undefined)
    await requestMagicLink(EMAIL, transport)

    const [, token] = transport.mock.calls[0] as [string, string]
    const userId = await verifyMagicLink(EMAIL, token)

    expect(typeof userId).toBe('string')
    expect(userId.length).toBeGreaterThan(0)

    const consumed = await prisma.magicLink.findUnique({ where: { email: EMAIL } })
    expect(consumed).toBeNull()
  })

  it('[4] verifyMagicLink — token invalide lève MAGIC_LINK_INVALID', async () => {
    const transport = vi.fn().mockResolvedValue(undefined)
    await requestMagicLink(EMAIL, transport)

    await expect(verifyMagicLink(EMAIL, '000000')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'MAGIC_LINK_INVALID',
    )
  })

  it('[5] verifyMagicLink — token expiré lève MAGIC_LINK_EXPIRED', async () => {
    await prisma.magicLink.upsert({
      where: { email: EMAIL },
      update: { token: '999999', expiresAt: new Date(Date.now() - 1_000), attempts: 0 },
      create: { email: EMAIL, token: '999999', expiresAt: new Date(Date.now() - 1_000) },
    })

    await expect(verifyMagicLink(EMAIL, '999999')).rejects.toSatisfy(
      (e: unknown) => e instanceof AppError && e.code === 'MAGIC_LINK_EXPIRED',
    )
  })
})
