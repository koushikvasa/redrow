import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsup'

// One ESM file with the engine inside it: `@redrow/engine` isn't published, and pointing
// at its source means the build doesn't depend on the workspace build order.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  noExternal: ['@redrow/engine'],
  esbuildOptions(options) {
    options.alias = {
      '@redrow/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    }
  },
})
