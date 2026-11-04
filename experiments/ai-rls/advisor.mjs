// Step 4: run Supabase's Security Advisor against carenote-demo while one app is applied.
//   node advisor.mjs <label>
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const CARENOTE_REF = 'rhzifgxalchaoeolrazv'
const label = process.argv[2]
const run = spawnSync('npx', ['supabase', 'db', 'advisors', `--remote=${CARENOTE_REF}`, '--type', 'security', '--level', 'info', '--output-format', 'json'], {
  encoding: 'utf8',
  shell: true,
  maxBuffer: 64 * 1024 * 1024,
})
if (run.status !== 0 && run.stdout.trim() === '') {
  console.log(`advisors failed: exit ${run.status}\n${run.stderr.slice(0, 800)}`)
  process.exit(1)
}
const out = new URL('advisor/', import.meta.url)
if (!existsSync(out)) mkdirSync(out)
writeFileSync(new URL(`${label}.json`, out), run.stdout)
const parsed = JSON.parse(run.stdout)
const lints = Array.isArray(parsed) ? parsed : (parsed.lints ?? parsed.issues ?? parsed.result ?? parsed.results ?? [])
console.log(`${label}: ${lints.length} lints; top-level keys ${Array.isArray(parsed) ? 'array' : Object.keys(parsed).join(',')}`)
for (const lint of lints) {
  const m = lint.metadata ?? {}
  console.log(`  ${lint.level} ${lint.name} ${m.schema ?? '-'}.${m.name ?? m.table ?? '-'} ${m.type ?? ''}`)
}
