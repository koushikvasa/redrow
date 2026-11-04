// Copies the personas to the dashboard, because Vercel uploads only apps/web.
// A test in apps/web fails if this copy and hq/redrow.config.json drift apart.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(root, 'hq', 'redrow.config.json'), 'utf8'))
const dir = join(root, 'apps', 'web', 'data')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'personas.json'), `${JSON.stringify(config.personas ?? {}, null, 2)}\n`)
process.stdout.write(`Copied the personas to ${dir}\n`)
