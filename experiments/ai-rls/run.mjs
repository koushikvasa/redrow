// Steps 2, 3 and 6. One app at a time, because all five outputs create the same trigger name on auth.users.
//   node run.mjs snapshot <label>   read-only fingerprint of what must not change
//   node run.mjs up <app>           apply, seed, then scan read-only and fully
//   node run.mjs down <app>         drop that app's schemas
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { scan, toReport } from '@redrow/engine'
import postgres from 'postgres'
import { APPS } from './apps.mjs'

process.loadEnvFile(new URL('../../.env', import.meta.url))

const here = new URL('./', import.meta.url)
const USERS = { ana: 'dr.ana@carenote.test', ben: 'dr.ben@carenote.test', cho: 'dr.cho@carenote.test' }
const FORBIDDEN = [
  /\bdrop\s/i,
  /\btruncate\b/i,
  /\balter\s+(role|database|system)\b/i,
  /\bcreate\s+role\b/i,
  /\bcopy\s/i,
  /\bpublic\s*\./i,
  /\bprivate\s*\./i,
  /\bstorage\./i,
  /\bauth\.(?!uid\(|jwt\(|users\b)/i,
  /\b(insert\s+into|update|delete\s+from)\s+auth\./i,
]

const connect = () => postgres(process.env.DEMO_DB_URL, { max: 4, ssl: 'require', prepare: false, connect_timeout: 15, onnotice: () => {} })

/** Only schema names change. `public` as a role, as in `from public, anon`, has no dot and stays. */
function rewrite(raw, schema) {
  return raw
    .replace(/\bpublic\s*\./g, `${schema}.`)
    .replace(/\bprivate\s*\./g, `${schema}_private.`)
    .replace(/\bschema\s+(if\s+not\s+exists\s+)?private\b/gi, (_, ifNot) => `schema ${ifNot ?? ''}${schema}_private`)
}

function firstSqlBlock(markdown) {
  const match = markdown.match(/^```sql\r?\n([\s\S]*?)^```/m)
  if (match === null) throw new Error('no sql block in the output')
  return match[1]
}

/** Supabase gives API roles these on `public`. A new schema has none, so without this every attack is falsely denied. */
const matchPublicDefaults = (schema) => `
  create schema ${schema};
  grant usage on schema ${schema} to anon, authenticated, service_role;
  alter default privileges in schema ${schema} grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema ${schema} grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema ${schema} grant all on functions to anon, authenticated, service_role;
`

async function userIds(sql) {
  const rows = await sql`select id::text, email from auth.users where email = any(${Object.values(USERS)}::text[])`
  const byEmail = new Map(rows.map((row) => [row.email, row.id]))
  return Object.fromEntries(Object.entries(USERS).map(([name, email]) => {
    const id = byEmail.get(email)
    if (id === undefined) throw new Error(`missing user ${name}`)
    return [name, id]
  }))
}

function summarize(report) {
  const allowed = report.summary.probes
    .filter((p) => p.outcome === 'allowed' && p.action !== 'select_own')
    .map((p) => `${p.table}:${p.actor}:${p.action}:${p.rowCount}`)
  const counted = report.findings.filter((f) => f.severity !== 'info').map((f) => `${f.id}:${f.severity}:${f.table ?? '-'}`)
  return { score: report.summary.score, grade: report.summary.grade, probes: report.summary.probesRun, allowed, findings: counted }
}

async function up(app) {
  const dir = new URL(`${app.dir}/`, here)
  const rewritten = rewrite(firstSqlBlock(readFileSync(new URL('output.md', dir), 'utf8')), app.schema)
  writeFileSync(new URL('rewritten.sql', dir), rewritten)
  const hit = FORBIDDEN.find((pattern) => pattern.test(rewritten))
  if (hit !== undefined) throw new Error(`refusing to apply, matched ${hit}`)

  const sql = connect()
  try {
    const existing = await sql`select nspname from pg_namespace where nspname = ${app.schema} or nspname = ${`${app.schema}_private`}`
    if (existing.length > 0) throw new Error(`${app.schema} already exists`)
    const ids = await userIds(sql)

    await sql.begin(async (tx) => {
      await tx.unsafe(matchPublicDefaults(app.schema))
      await tx.unsafe(`set local search_path = ${app.schema}, extensions`)
      await tx.unsafe(rewritten)
    })
    console.log(`${app.dir}: applied`)

    const seed = readFileSync(new URL('seed.sql', dir), 'utf8').replace(/:(ana|ben|cho)\b/g, (_, name) => `'${ids[name]}'::uuid`)
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role service_role')
      await tx.unsafe(seed)
    })
    console.log(`${app.dir}: seeded`)

    const results = {}
    const options = { schemas: [app.schema], ownerColumns: app.ownerColumns }
    const others = (attacker) => Object.keys(ids).find((name) => name !== attacker)
    for (const attacker of Object.keys(ids)) {
      const actors = { userA: ids[attacker], userB: ids[others(attacker)] }
      const readOnly = summarize(toReport(await scan(sql, { ...options, actors, readOnly: true })))
      const full = summarize(toReport(await scan(sql, { ...options, actors })))
      results[attacker] = { readOnly, full }
      console.log(`${app.dir} as ${attacker}: read-only ${readOnly.score}/${readOnly.grade}, full ${full.score}/${full.grade}, ${full.probes} probes`)
      console.log(`  allowed: ${full.allowed.join(' ') || 'none'}`)
      console.log(`  findings: ${full.findings.join(' ') || 'none'}`)
    }
    writeFileSync(new URL('results.json', dir), `${JSON.stringify(results, null, 2)}\n`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function down(app) {
  const sql = connect()
  try {
    await sql.unsafe(`drop schema if exists ${app.schema} cascade; drop schema if exists ${app.schema}_private cascade;`)
    const left = await sql`select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal`
    console.log(`${app.dir}: dropped, triggers left on auth.users: ${left.length}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The Advisor only lints schemas in pgrst.db_schemas, so it can't see these. This runs its linter, read-only, as if they were exposed. */
async function lint(app, splinterPath) {
  const sql = connect()
  try {
    const statements = readFileSync(splinterPath, 'utf8')
    const rows = await sql.begin('read only', async (tx) => {
      await tx.unsafe(`set local pgrst.db_schemas = '${app.schema}'`)
      const results = await tx.unsafe(statements)
      return [...results].flat().filter((row) => row.name !== undefined)
    })
    const found = rows.map((r) => ({ name: r.name, level: r.level, schema: r.metadata?.schema ?? null, object: r.metadata?.name ?? null }))
    const out = new URL('advisor/', here)
    if (!existsSync(out)) mkdirSync(out)
    writeFileSync(new URL(`${app.dir}-splinter.json`, out), `${JSON.stringify(found, null, 2)}\n`)
    const relevant = found.filter((f) => f.schema !== null && f.schema.startsWith(app.schema))
    console.log(`${app.dir} splinter: ${found.length} lints, ${relevant.length} on ${app.schema}`)
    for (const f of relevant) console.log(`  ${f.level} ${f.name} ${f.schema}.${f.object}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function snapshot(label) {
  const sql = connect()
  try {
    const result = await sql.begin('read only', async (tx) => {
      const fingerprint = async (query) => (await tx.unsafe(`select md5(coalesce(string_agg(x, '|' order by x), '')) as h, count(*)::int as n from (${query}) q(x)`))[0]
      const tables = await tx`select tablename from pg_tables where schemaname = 'public' order by 1`
      const counts = {}
      for (const { tablename } of tables) counts[tablename] = (await tx`select count(*)::int as n from ${tx('public')}.${tx(tablename)}`)[0].n
      return {
        schemas: (await tx`select nspname from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1`).map((r) => r.nspname),
        public_counts: counts,
        public_columns: await fingerprint(`select table_name || '.' || column_name || ':' || data_type from information_schema.columns where table_schema = 'public'`),
        public_policies: await fingerprint(`select tablename || policyname || coalesce(qual, '') || coalesce(with_check, '') from pg_policies where schemaname = 'public'`),
        public_functions: await fingerprint(`select p.proname || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`),
        public_triggers: await fingerprint(`select c.relname || t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal`),
        public_acl: await fingerprint(`select c.relname || coalesce(c.relacl::text, '') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`),
        auth_users_triggers: await fingerprint(`select t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal`),
        extensions: await fingerprint(`select e.extname || '@' || n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace`),
        realtime_tables: await fingerprint(`select schemaname || '.' || tablename from pg_publication_tables where pubname = 'supabase_realtime'`),
      }
    })
    const out = new URL('snapshots/', here)
    if (!existsSync(out)) mkdirSync(out)
    writeFileSync(new URL(`${label}.json`, out), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const [command, argument] = process.argv.slice(2)
const appNamed = (name) => {
  const app = APPS.find((a) => a.dir === name)
  if (app === undefined) throw new Error(`unknown app ${name}`)
  return app
}
if (command === 'snapshot') await snapshot(argument)
else if (command === 'up') await up(appNamed(argument))
else if (command === 'down') await down(appNamed(argument))
else if (command === 'lint') await lint(argument === 'carenote-public' ? { dir: argument, schema: 'public' } : appNamed(argument), process.argv[4])
else throw new Error('usage: run.mjs snapshot <label> | up <app> | lint <app> <splinter.sql> | down <app>')
