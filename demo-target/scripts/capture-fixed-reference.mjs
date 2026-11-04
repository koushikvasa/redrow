// Scans CareNote with the reference fix applied and stores the result for the dashboard's
// "See it fixed" view, then puts the demo back to leaky. Counts only, with no user ids.
//
// The sweep is paused meanwhile. HQ is insert-only, so a scan of the fixed database would stay
// in its history for good. It always resumes, and the demo always resets, even after a failure.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { scan, toReport } from '@redrow/engine'
import postgres from 'postgres'

process.loadEnvFile(new URL('../../.env', import.meta.url))

const OUTPUT = new URL('../../apps/web/data/fixed-reference.json', import.meta.url)
const SWEEP_JOB = 'redrow-sweep'
/** Longer than the 15s timeout on the sweep's request, so none is still in flight. */
const SWEEP_DRAIN_MS = 16_000
const SSL_OPTIONS = { max: 4, ssl: 'require', prepare: false, connect_timeout: 15, onnotice: () => {} }

const npmRun = (script) => {
  const { status } = spawnSync('npm', ['run', script], { cwd: new URL('../..', import.meta.url), shell: true, stdio: 'ignore' })
  if (status !== 0) throw new Error(`npm run ${script} failed`)
}

async function scanDemo() {
  const demo = postgres(process.env.DEMO_DB_URL, SSL_OPTIONS)
  try {
    return await scan(demo, {})
  } finally {
    await demo.end({ timeout: 5 })
  }
}

function writeReference(result) {
  const report = toReport(result)
  if (report.summary.score !== 100) throw new Error(`Expected 100 with the fix applied, got ${report.summary.score}`)
  const reference = {
    project: 'CareNote demo',
    scannedAt: report.scannedAt,
    score: report.summary.score,
    grade: report.summary.grade,
    tablesScanned: report.summary.tablesScanned,
    probesRun: report.summary.probesRun,
    durationMs: report.summary.durationMs,
    probes: report.summary.probes.map((p) => ({
      table_name: p.table,
      actor: p.actor,
      action: p.action,
      outcome: p.outcome,
      row_count: p.rowCount,
    })),
  }
  writeFileSync(OUTPUT, `${JSON.stringify(reference, null, 2)}\n`)
  process.stdout.write(`With the fix: ${report.summary.score}/${report.summary.grade}, ${report.summary.probesRun} probes\n`)
}

const hq = postgres(process.env.HQ_DB_URL, { ...SSL_OPTIONS, max: 1 })
const setSweepActive = (active) =>
  hq`select cron.alter_job(job_id := (select jobid from cron.job where jobname = ${SWEEP_JOB}), active := ${active})`

try {
  await setSweepActive(false)
  process.stdout.write('Sweep paused\n')
  await new Promise((resolve) => setTimeout(resolve, SWEEP_DRAIN_MS))
  try {
    npmRun('demo:fix-reference')
    writeReference(await scanDemo())
  } finally {
    npmRun('demo:reset')
    const after = await scanDemo()
    process.stdout.write(`Reset. Live demo: ${after.score}/${after.grade}, ${after.findings.length} findings\n`)
  }
} finally {
  await setSweepActive(true)
  process.stdout.write('Sweep resumed\n')
  await hq.end({ timeout: 5 })
}
