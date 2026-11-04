// POST { project, report } with header x-redrow-key. Used by `redrow scan --upload`.
import postgres from 'postgres'
import { json, safeEqual } from '../_shared/auth.ts'
import { toScanRows, type Report } from '../_shared/engine/index.js'
import { MAX_BODY_BYTES, ingestBody } from '../_shared/report-schema.ts'
import { CONNECTION_OPTIONS, insertScan } from '../_shared/store.ts'

const fail = (status: number, error: string): Response => json(status, { success: false, data: null, error })

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text()
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new RangeError('too large')
  return JSON.parse(text)
}

async function store(project: string, report: Report): Promise<Response> {
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL') as string, CONNECTION_OPTIONS)
  try {
    const found = await sql<{ id: string }[]>`select id from public.projects where name = ${project} limit 1`
    const id = found[0]?.id
    if (id === undefined) return fail(404, 'No such project')
    const scanRunId = await insertScan(sql, toScanRows(report, id, 'cli'))
    return json(201, { success: true, data: { scanRunId }, error: null })
  } finally {
    await sql.end({ timeout: 2 })
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return fail(405, 'POST only')
  if (!safeEqual(req.headers.get('x-redrow-key') ?? '', Deno.env.get('REDROW_INGEST_KEY') ?? '')) {
    return fail(401, 'Missing or wrong x-redrow-key')
  }
  let body: unknown
  try {
    body = await readBody(req)
  } catch {
    return fail(400, 'The body must be JSON, under 5 MB')
  }
  const parsed = ingestBody.safeParse(body)
  if (!parsed.success) return fail(400, `Not a valid report: ${parsed.error.issues[0]?.path.join('.') ?? 'body'}`)
  try {
    return await store(parsed.data.project, parsed.data.report as Report)
  } catch (error) {
    // The code only: a driver message could quote the values being inserted.
    console.error('ingest failed', (error as { code?: string }).code ?? 'unknown')
    return fail(500, 'Could not store the report')
  }
})
