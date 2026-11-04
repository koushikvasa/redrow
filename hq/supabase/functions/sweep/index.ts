// Called by pg_cron every 20 seconds: scans each demo database in turn and stores the results.
// About every other pg_net request stalls before it gets here, so cron retries often and this
// skips a database swept in the last 50 seconds, which keeps it to about one scan a minute.
// Every probe is rolled back, as in any scan. Only the stored result persists.
import postgres, { type Sql } from 'postgres'
import { bearerToken, json, safeEqual } from '../_shared/auth.ts'
import { scan, toReport, toScanRows } from '../_shared/engine/index.js'
import { CONNECTION_OPTIONS, insertScan } from '../_shared/store.ts'

interface Target {
  readonly project: string
  readonly urlEnv: string
  /** The judges' board is meant to be readable by anon, so that read scores nothing. */
  readonly publicTables: readonly string[]
}

const STORE_URL_ENV = 'SUPABASE_DB_URL'

// HQ is scanned through its session pooler, like any other target. A scan over
// SUPABASE_DB_URL never finishes on the edge, though storing a result over it works.
const TARGETS: readonly Target[] = [
  { project: 'CareNote demo', urlEnv: 'DEMO_DB_URL', publicTables: [] },
  { project: 'Red Row HQ (self-scan)', urlEnv: 'HQ_POOLER_DB_URL', publicTables: ['projects'] },
]

async function sweepTarget(hq: Sql, target: Target) {
  const found = await hq<{ id: string }[]>`select id from public.projects where name = ${target.project} limit 1`
  const projectId = found[0]?.id
  if (projectId === undefined) throw new Error('project not seeded')
  const recent = await hq`
    select 1 from public.scan_runs
    where project_id = ${projectId} and source = 'sweep' and created_at > now() - interval '50 seconds'
    limit 1`
  if (recent.length > 0) return { project: target.project, skipped: true }
  const url = Deno.env.get(target.urlEnv)
  if (url === undefined) throw new Error('database url not set')
  const source = postgres(url, CONNECTION_OPTIONS)
  try {
    const result = await scan(source, { publicTables: target.publicTables })
    // A scan where nothing could be tested proved nothing, and must not show up as clean.
    if (result.probes.length > 0 && result.probes.every((p) => p.outcome === 'inconclusive')) {
      throw new Error('every probe was inconclusive')
    }
    await insertScan(hq, toScanRows(toReport(result), projectId, 'sweep'))
    return { project: target.project, score: result.score, grade: result.grade, durationMs: result.durationMs }
  } finally {
    await source.end({ timeout: 2 })
  }
}

/** One target failing must not cost the other its scan. */
async function sweepSafely(hq: Sql, target: Target) {
  try {
    return await sweepTarget(hq, target)
  } catch (error) {
    // A code or our own short message. A driver message could quote a connection detail.
    const reason = error as { code?: string; message?: string }
    const code = reason.code ?? (reason.message ?? 'failed').slice(0, 60)
    console.error('sweep failed', target.project, code)
    return { project: target.project, error: code }
  }
}

Deno.serve(async (req) => {
  if (!safeEqual(bearerToken(req.headers.get('authorization')), Deno.env.get('SWEEP_TOKEN') ?? '')) {
    return json(401, { success: false, data: null, error: 'Unauthorized' })
  }
  const hq = postgres(Deno.env.get(STORE_URL_ENV) as string, CONNECTION_OPTIONS)
  try {
    const results = []
    for (const target of TARGETS) results.push(await sweepSafely(hq, target))
    const anyStored = results.some((result) => !('error' in result))
    return json(anyStored ? 200 : 500, { success: anyStored, data: results, error: anyStored ? null : 'Nothing stored' })
  } finally {
    await hq.end({ timeout: 2 })
  }
})
