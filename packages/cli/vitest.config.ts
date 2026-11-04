import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@redrow/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../scripts/vitest-global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The bin entry and the spinner only wire real process streams together.
      exclude: ['src/index.ts', 'src/progress.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
