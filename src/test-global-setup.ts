import { execSync } from 'node:child_process'

/**
 * Bootstrap vitest (globalSetup) : applique les migrations versionnées sur la
 * base de test AVANT toute suite — remplace l'ancien `prisma db push` manuel.
 * Idempotent : `migrate deploy` ne rejoue que les migrations manquantes.
 */
export default function setupTestDatabase(): void {
  // Garde-fou : ne JAMAIS migrer/purger autre chose que la base de test dédiée
  // (chaque suite re-vérifie de son côté avant ses deleteMany).
  if (!process.env.DATABASE_URL?.includes('waylo_test')) {
    throw new Error('DATABASE_URL doit cibler la base waylo_test')
  }
  // Le schéma déclare `directUrl = env("DIRECT_URL")` (séparation migrations/runtime
  // en prod). En test il n'existe qu'une base `waylo_test` : on fait défaut
  // DIRECT_URL → DATABASE_URL pour que `migrate deploy` (qui lit directUrl) tourne.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DIRECT_URL: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
  })
}
