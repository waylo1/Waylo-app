import { describe, expect, it, vi } from 'vitest'
import { keepAlivePing } from './keep-alive'

/**
 * Keep-alive anti-pause Supabase — sonde DB `SELECT 1`.
 * Unitaire (prisma injecté) : aucune vraie base requise.
 */
describe('keep-alive — keepAlivePing', () => {
  it('exécute une sonde DB (SELECT 1) et journalise le succès', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([{ '?column?': 1 }])
    const info = vi.fn()

    await keepAlivePing({ prisma: { $queryRaw } as never, log: { info } })

    expect($queryRaw).toHaveBeenCalledTimes(1) // touche bien la DB (read-only, idempotent)
    expect(info).toHaveBeenCalledTimes(1) // succès journalisé
  })

  it('propage l\'échec DB (capté par la boucle, pas avalé ici)', async () => {
    const $queryRaw = vi.fn().mockRejectedValue(new Error('DB unreachable'))

    await expect(
      keepAlivePing({ prisma: { $queryRaw } as never, log: { info: vi.fn() } }),
    ).rejects.toThrow('DB unreachable')
  })
})
