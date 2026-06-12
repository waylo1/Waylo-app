import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dir: 'src',
    // Schéma appliqué par migrations versionnées avant toute suite.
    globalSetup: './src/test-global-setup.ts',
    // Les suites purgent la même base waylo_test en beforeAll :
    // exécution séquentielle obligatoire (équivalent --no-file-parallelism).
    fileParallelism: false,
  },
})
