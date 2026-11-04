import { createServerClient } from '@supabase/ssr'
import type { FindingRow, HourlyScore, ProbeRow, Project, RecentScore, ScanRun } from './types'

const DAY_MS = 86_400_000
const HISTORY_DAYS = 14
const MAX_HOURLY_POINTS = HISTORY_DAYS * 24 + 1
const RECENT_MS = 3 * 3_600_000
const MAX_RECENT = 400
const SCAN_COLUMNS = 'id,source,score,grade,critical,high,medium,low,tables_scanned,probes_run,duration_ms,created_at'

export interface BoardCard {
  readonly project: Project
  readonly latest: ScanRun | null
  readonly hourly: readonly HourlyScore[]
  readonly recent: readonly RecentScore[]
}

export interface ProjectView extends BoardCard {
  readonly findings: readonly FindingRow[]
  readonly probes: readonly ProbeRow[]
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** The public anon key, so this reads exactly what RLS shows anyone. There are no sessions here. */
const client = () =>
  createServerClient(
    requireEnv(process.env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    { cookies: { getAll: () => [], setAll: () => {} } },
  )

type Client = ReturnType<typeof client>

function rows<T>(result: { data: unknown; error: { message: string } | null }, what: string): T[] {
  if (result.error !== null) throw new Error(`Could not load ${what}: ${result.error.message}`)
  return (result.data ?? []) as T[]
}

async function loadCard(db: Client, project: Project): Promise<BoardCard> {
  const now = Date.now()
  const [latest, hourly, recent] = await Promise.all([
    db.from('scan_runs').select(SCAN_COLUMNS).eq('project_id', project.id).order('created_at', { ascending: false }).limit(1),
    db
      .from('score_history')
      .select('hour,score,seeded')
      .eq('project_id', project.id)
      .gte('hour', new Date(now - HISTORY_DAYS * DAY_MS).toISOString())
      .order('hour', { ascending: false })
      .limit(MAX_HOURLY_POINTS),
    db
      .from('scan_runs')
      .select('score,source,created_at')
      .eq('project_id', project.id)
      .gte('created_at', new Date(now - RECENT_MS).toISOString())
      .order('created_at', { ascending: false })
      .limit(MAX_RECENT),
  ])
  return {
    project,
    latest: rows<ScanRun>(latest, 'the latest scan')[0] ?? null,
    hourly: rows<HourlyScore>(hourly, 'score history'),
    recent: rows<RecentScore>(recent, 'recent scans'),
  }
}

export async function loadBoard(): Promise<BoardCard[]> {
  const db = client()
  const projects = rows<Project>(
    await db.from('projects').select('id,name,host_masked').eq('is_public', true).order('name'),
    'projects',
  )
  return await Promise.all(projects.map((project) => loadCard(db, project)))
}

export async function loadProject(id: string): Promise<ProjectView | null> {
  const db = client()
  const projects = rows<Project>(await db.from('projects').select('id,name,host_masked').eq('id', id).limit(1), 'the project')
  const project = projects[0]
  if (project === undefined) return null
  const card = await loadCard(db, project)
  if (card.latest === null) return { ...card, findings: [], probes: [] }
  const [findings, probes] = await Promise.all([
    db
      .from('findings')
      .select('id,rule_id,severity,schema_name,table_name,title,detail,rows_exposed,fix_hint')
      .eq('scan_run_id', card.latest.id)
      .limit(1000),
    db.from('probe_results').select('table_name,actor,action,outcome,row_count').eq('scan_run_id', card.latest.id).limit(1000),
  ])
  return { ...card, findings: rows<FindingRow>(findings, 'findings'), probes: rows<ProbeRow>(probes, 'the leak matrix') }
}
