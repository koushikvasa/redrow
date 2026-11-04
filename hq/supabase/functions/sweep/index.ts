// Called by pg_cron every minute, once per target: scans that database and stores the result.
// One target per call, because the two together run past an edge function's compute limit.
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
const TARGETS: Readonly<Record<string, Target>> = {
  carenote: { project: 'CareNote demo', urlEnv: 'DEMO_DB_URL', publicTables: [] },
  hq: { project: 'Red Row HQ (self-scan)', urlEnv: 'HQ_POOLER_DB_URL', publicTables: ['projects'] },
}

async function scanAndStore(hq: Sql, source: Sql, target: Target, projectId: string) {
  const result = await scan(source, { publicTables: target.publicTables })
  // A scan where nothing could be tested proved nothing, and must not show up as clean.
  if (result.probes.length > 0 && result.probes.every((p) => p.outcome === 'inconclusive')) {
    throw new Error('every probe was inconclusive')
  }
  await insertScan(hq, toScanRows(toReport(result), projectId, 'sweep'))
  return { project: target.project, score: result.score, grade: result.grade, durationMs: result.durationMs }
}

async function sweep(hq: Sql, target: Target) {
  const found = await hq<{ id: string }[]>`select id from public.projects where name = ${target.project} limit 1`
  const projectId = found[0]?.id
  if (projectId === undefined) throw new Error('project not seeded')
  const url = Deno.env.get(target.urlEnv)
  if (url === undefined) throw new Error('database url not set')
  const source = postgres(url, CONNECTION_OPTIONS)
  try {
    return await scanAndStore(hq, source, target, projectId)
  } finally {
    await source.end({ timeout: 2 })
  }
}

Deno.serve(async (req) => {
  if (!safeEqual(bearerToken(req.headers.get('authorization')), Deno.env.get('SWEEP_TOKEN') ?? '')) {
    return json(401, { success: false, data: null, error: 'Unauthorized' })
  }
  const target = TARGETS[new URL(req.url).searchParams.get('target') ?? '']
  if (target === undefined) return json(400, { success: false, data: null, error: 'Pass ?target=carenote or ?target=hq' })
  const hq = postgres(Deno.env.get(STORE_URL_ENV) as string, CONNECTION_OPTIONS)
  try {
    return json(200, { success: true, data: await sweep(hq, target), error: null })
  } catch (error) {
    // A code or our own short message. A driver message could quote a connection detail.
    const reason = error as { code?: string; message?: string }
    const code = reason.code ?? (reason.message ?? 'failed').slice(0, 60)
    console.error('sweep failed', target.project, code)
    return json(500, { success: false, data: null, error: code })
  } finally {
    await hq.end({ timeout: 2 })
  }
})
