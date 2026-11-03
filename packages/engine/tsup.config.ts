import { defineConfig } from 'tsup'

// One ESM file with no runtime imports, so hq's edge functions can load the
// same build from Deno after `npm run sync:engine`.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
})
