// Copies the engine's build to where the edge functions import it, because Deno deploys
// only what's under supabase/functions. Run after changing packages/engine.
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'packages', 'engine', 'dist')
const to = join(root, 'hq', 'supabase', 'functions', '_shared', 'engine')

mkdirSync(to, { recursive: true })
for (const file of ['index.js', 'index.d.ts']) copyFileSync(join(from, file), join(to, file))
process.stdout.write(`Copied the engine build to ${to}\n`)
