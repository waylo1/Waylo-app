import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname),
  test: {
    include: ['src/automation/**/*.test.ts'],
    environment: 'node',
    // Pas de globalSetup DB — tests purement unitaires, zéro I/O réseau.
  },
})
