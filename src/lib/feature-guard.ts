import { prisma } from '../db'

/**
 * Pilote le déploiement progressif des features à risque (RLS, etc.).
 *
 * Modes :
 *   'off'     — feature inerte (état initial + cible kill switch)
 *   'shadow'  — mesure sans effet (log d'écarts, bypass toujours actif)
 *   'enforce' — feature réellement appliquée
 *
 * Fail-safe strict : toute erreur ou clé absente → 'off'.
 * Jamais d'enforce accidentel en cas de panne DB.
 */

export type FlagMode = 'off' | 'shadow' | 'enforce'

interface CacheEntry {
  mode: FlagMode
  at: number
}

const TTL_MS = 5_000
const cache = new Map<string, CacheEntry>()

export class FeatureGuard {
  /**
   * Lecture avec cache TTL. Retourne 'off' sur toute panne ou clé inconnue.
   * Kill switch propagé en < TTL_MS (5 s).
   */
  static async mode(key: string, nowMs: number = Date.now()): Promise<FlagMode> {
    const hit = cache.get(key)
    if (hit && nowMs - hit.at < TTL_MS) return hit.mode

    try {
      const row = await prisma.featureFlag.findUnique({
        where: { key },
        select: { mode: true },
      })
      const mode = isValidMode(row?.mode) ? (row!.mode as FlagMode) : 'off'
      cache.set(key, { mode, at: nowMs })
      return mode
    } catch {
      return 'off'
    }
  }

  /**
   * KILL SWITCH : repasse la clé à 'off' immédiatement (évince le cache).
   * Toute requête suivante voit 'off' dès la prochaine lecture (< TTL_MS).
   */
  static async kill(key: string, adminId: string): Promise<void> {
    await prisma.featureFlag.update({
      where: { key },
      data: { mode: 'off', updatedBy: adminId },
    })
    cache.delete(key)
  }

  /** Teste si le mode courant active le bypass (off | shadow → bypass). */
  static bypass(mode: FlagMode): boolean {
    return mode !== 'enforce'
  }
}

function isValidMode(v: string | null | undefined): boolean {
  return v === 'off' || v === 'shadow' || v === 'enforce'
}
