// Rate limiter anti-brute-force EN MÉMOIRE (léger, sans dépendance) : fenêtre
// fixe, max RATE_LIMIT_MAX requêtes par RATE_LIMIT_WINDOW_MS et par clé.
// Mono-process : suffisant ici (stockage léger en mémoire).
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60_000
const rateBuckets = new Map<string, { count: number; resetAt: number }>()

export function isRateLimited(key: string): boolean {
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  if (bucket.count >= RATE_LIMIT_MAX) return true
  bucket.count += 1
  return false
}
