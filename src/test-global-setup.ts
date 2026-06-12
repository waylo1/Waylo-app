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
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env })
}
