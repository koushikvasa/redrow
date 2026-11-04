// Backfills 14 days of history for the two public projects, so the dashboard has a past and
// Sodabase can learn what fresh looks like. Inserts only, and rerunning adds nothing.
// Every backfilled row has source = 'seed', so it can't be mistaken for a real scan.
//
// The findings come from one real scan of each database, with a little drift on top.
import { randomBytes, randomUUID } from 'node:crypto'
import { scan, toReport, toScanRows } from '@redrow/engine'
import postgres from 'postgres'

process.loadEnvFile(new URL('../../.env', import.meta.url))

const DAYS = 14
const STEP_MINUTES = 15
const BATCH = 1000
const CARENOTE = 'CareNote demo'
const HQ = 'Red Row HQ (self-scan)'
const OWNERS = { [CARENOTE]: 'carenote-owner@redrow.test', [HQ]: 'hq-owner@redrow.test' }

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Add it to .env.`)
  return value
}

const connect = (url) => postgres(url, { max: 6, ssl: 'require', prepare: false, connect_timeout: 15, onnotice: () => {} })
const hq = connect(requireEnv('HQ_DB_URL'))
const demo = connect(requireEnv('DEMO_DB_URL'))
const supabaseUrl = requireEnv('HQ_SUPABASE_URL')
const serviceKey = requireEnv('HQ_SERVICE_ROLE_KEY')

async function ensureOwner(email) {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' }
  const existing = await hq`select id from auth.users where email = ${email}`
  if (existing[0]) return existing[0].id
  // Nobody signs in as these: the password is random and thrown away.
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password: randomBytes(32).toString('hex'), email_confirm: true }),
  })
  if (!response.ok) throw new Error(`Could not create ${email}: HTTP ${response.status}`)
  return (await response.json()).id
}

async function ensureProject(name, host) {
  const ownerId = await ensureOwner(OWNERS[name])
  await hq`
    insert into public.projects (owner_id, name, host_masked, is_public)
    values (${ownerId}, ${name}, ${host}, true)
    on conflict (owner_id, name) do nothing`
  const rows = await hq`select id from public.projects where owner_id = ${ownerId} and name = ${name}`
  return rows[0].id
}

const randomInt = (max) => Math.floor(Math.random() * (max + 1))

/** CareNote hovers at 0 to 10 as a few low findings come and go. HQ stays at 100. */
function drifted(rows, name) {
  const lowToDrop = name === CARENOTE ? randomInt(2) : 0
  let dropped = 0
  const findings = rows.findings.filter((f) => {
    if (f.severity !== 'low' || dropped >= lowToDrop) return true
    dropped += 1
    return false
  })
  const score = name === CARENOTE ? Math.min(10, rows.run.score + dropped * 5) : rows.run.score
  return {
    run: {
      ...rows.run,
      score,
      low: rows.run.low - dropped,
      duration_ms: Math.max(500, rows.run.duration_ms + randomInt(1500) - 750),
      source: 'seed',
    },
    findings,
    probes: rows.probes,
  }
}

async function insertInBatches(tx, table, rows) {
  for (let start = 0; start < rows.length; start += BATCH) {
    await tx`insert into ${tx('public')}.${tx(table)} ${tx(rows.slice(start, start + BATCH))}`
  }
}

async function backfill(name, projectId, rows) {
  const already = await hq`select count(*)::int as n from public.scan_runs where project_id = ${projectId} and source = 'seed'`
  if (already[0].n > 0) {
    console.log(`${name}: already seeded (${already[0].n} scans), adding nothing`)
    return
  }
  const scans = (DAYS * 24 * 60) / STEP_MINUTES
  const now = Date.now()
  const runs = []
  const findings = []
  const probes = []
  for (let i = scans; i >= 1; i -= 1) {
    const created_at = new Date(now - i * STEP_MINUTES * 60_000)
    const id = randomUUID()
    const scanRows = drifted(rows, name)
    runs.push({ ...scanRows.run, id, created_at })
    for (const f of scanRows.findings) findings.push({ ...f, scan_run_id: id, created_at })
    for (const p of scanRows.probes) probes.push({ ...p, scan_run_id: id, created_at })
  }
  await hq.begin(async (tx) => {
    await insertInBatches(tx, 'scan_runs', runs)
    await insertInBatches(tx, 'findings', findings)
    await insertInBatches(tx, 'probe_results', probes)
  })
  console.log(`${name}: ${runs.length} scans, ${findings.length} findings, ${probes.length} probes`)
}

try {
  const demoHost = new URL(requireEnv('DEMO_DB_URL')).hostname
  const hqHost = new URL(requireEnv('HQ_DB_URL')).hostname
  const carenoteId = await ensureProject(CARENOTE, demoHost)
  const hqId = await ensureProject(HQ, hqHost)

  const carenote = await scan(demo, {})
  console.log(`${CARENOTE}: real scan ${carenote.score}/${carenote.grade}, ${carenote.findings.length} findings`)
  if (carenote.score > 30) throw new Error('CareNote should be leaky. Run npm run demo:reset first.')
  const self = await scan(hq, { publicTables: ['projects'] })
  console.log(`${HQ}: real scan ${self.score}/${self.grade}, ${self.findings.length} findings`)

  await backfill(CARENOTE, carenoteId, toScanRows(toReport(carenote), carenoteId, 'seed'))
  await backfill(HQ, hqId, toScanRows(toReport(self), hqId, 'seed'))
} finally {
  await Promise.all([hq.end({ timeout: 5 }), demo.end({ timeout: 5 })])
}
