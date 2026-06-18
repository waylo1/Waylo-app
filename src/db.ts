import { PrismaClient } from './generated/prisma'

/**
 * Client Prisma Waylo (schéma racine prisma/schema.prisma, sortie src/generated/prisma).
 *
 * Deux durcissements anti-épuisement de connexions (DoS) :
 *
 * 1. SINGLETON global — `new PrismaClient()` ouvre son propre pool. En dev
 *    (rechargement à chaud) ou si le module est ré-évalué, on réutilise l'unique
 *    instance via `globalThis` au lieu d'accumuler des pools fantômes. En
 *    production on n'attache PAS à globalThis (le module n'est importé qu'une fois).
 *
 * 2. PLAFOND de pool — sur Fly, plusieurs machines `auto_start` tapent UNE base
 *    Supabase à connexions limitées (connexion DIRECTE, pas le pooler — cf.
 *    gotchas.md). Chaque instance borne son pool via `connection_limit` sur l'URL
 *    (seul canal lu par Prisma) → l'addition des instances ne sature plus la base.
 *    Surchargeable par DATABASE_CONNECTION_LIMIT ; défaut prudent.
 */

const DEFAULT_CONNECTION_LIMIT = 5

/** Entier > 0 depuis DATABASE_CONNECTION_LIMIT, sinon le défaut. */
function resolveConnectionLimit(): number {
  const raw = process.env.DATABASE_CONNECTION_LIMIT
  if (raw === undefined || raw === '') return DEFAULT_CONNECTION_LIMIT
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_CONNECTION_LIMIT
}

/**
 * Ajoute `connection_limit` à l'URL Postgres si absent — idempotent, et par
 * manipulation de chaîne (jamais `new URL()`) pour ne JAMAIS ré-encoder un mot de
 * passe à caractères spéciaux. `undefined` laissé tel quel (Prisma lira le schéma).
 */
function withConnectionLimit(url: string | undefined): string | undefined {
  if (!url || /[?&]connection_limit=/.test(url)) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}connection_limit=${resolveConnectionLimit()}`
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ datasourceUrl: withConnectionLimit(process.env.DATABASE_URL) })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
