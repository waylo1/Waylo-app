import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dir: 'src',
    // Schéma appliqué par migrations versionnées avant toute suite.
    globalSetup: './src/test-global-setup.ts',
    // Les suites purgent la même base waylo_test en beforeAll :
    // exécution séquentielle obligatoire (équivalent --no-file-parallelism).
    fileParallelism: false,
    // Rate-limiter désormais sur store Postgres PERSISTANT : sans purge entre
    // suites, les compteurs s'additionneraient sur la durée du run. Aucune suite
    // n'asserte le 429 → on relève le seuil pour neutraliser le limiteur en test
    // (le comportement prod reste 5/60s via les défauts de rate-limit.ts).
    env: { RATE_LIMIT_MAX: '1000000' },
  },
})
