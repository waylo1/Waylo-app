import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    dir: 'src',
    // Les trois suites purgent la même base waylo_test en beforeAll :
    // exécution séquentielle obligatoire (équivalent --no-file-parallelism).
    fileParallelism: false,
  },
})
