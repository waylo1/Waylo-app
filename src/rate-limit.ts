import { prisma } from './db'

// Rate limiter DISTRIBUÉ (store Postgres) : compteur partagé entre toutes les
// instances Fly et persistant aux redémarrages — corrige la Map en mémoire
// mono-process (contournable par scale-out / reset mémoire). Fenêtre fixe :
// au plus RATE_LIMIT_MAX requêtes par RATE_LIMIT_WINDOW_MS et par clé.
// Surchargeables par env (les tests relèvent le seuil pour ne pas se gêner).

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const RATE_LIMIT_MAX = intEnv('RATE_LIMIT_MAX', 5)
const RATE_LIMIT_WINDOW_MS = intEnv('RATE_LIMIT_WINDOW_MS', 60_000)

/**
 * Masque une IP pour la clé de rate-limit : IPv4 → /24, IPv6 → /64. Empêche le
 * contournement trivial par rotation d'adresse dans un même sous-réseau, sans
 * pour autant agréger des réseaux entiers sous une seule clé.
 */
export function maskIp(ip: string): string {
  if (ip.includes(':')) {
    // IPv6 : préfixe /64 (4 premiers hextets) — couvre une seule sous-allocation.
    return ip.split(':').slice(0, 4).join(':') + '::/64'
  }
  const octets = ip.split('.')
  if (octets.length === 4) return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`
  return ip // forme inattendue : clé telle quelle plutôt que de masquer à tort
}

/**
 * Incrémente atomiquement le compteur de la clé dans la fenêtre courante et
 * renvoie `true` si le seuil est dépassé.
 *
 * UPSERT atomique (INSERT … ON CONFLICT DO UPDATE) : une seule instruction →
 * verrou de ligne implicite côté Postgres → sûr même sous requêtes concurrentes
 * multi-instances (aucune lecture-puis-écriture TOCTOU). La fenêtre est
 * réinitialisée quand `expiresAt` est dépassé. `now`/`expiresAt` sont fournis par
 * l'app (et non `now()` SQL) pour éviter toute ambiguïté timestamp/timestamptz ;
 * la dérive d'horloge entre instances (NTP, ~ms) est négligeable pour une fenêtre.
 *
 * Tolérant aux pannes : une erreur DB ne verrouille pas l'accès (fail-open) —
 * l'opération protégée requiert de toute façon la DB et échouera d'elle-même,
 * donc ouvrir le limiteur n'expose aucune surface supplémentaire.
 */
export async function isRateLimited(key: string): Promise<boolean> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + RATE_LIMIT_WINDOW_MS)
  try {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "RateLimit" ("key", "count", "expiresAt")
      VALUES (${key}, 1, ${expiresAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."expiresAt" < ${now}
                       THEN 1 ELSE "RateLimit"."count" + 1 END,
        "expiresAt" = CASE WHEN "RateLimit"."expiresAt" < ${now}
                           THEN ${expiresAt} ELSE "RateLimit"."expiresAt" END
      RETURNING "count"
    `
    const count = Number(rows[0]?.count ?? 1)
    return count > RATE_LIMIT_MAX
  } catch {
    return false // fail-open : disponibilité > blocage sur panne DB du limiteur
  }
}
