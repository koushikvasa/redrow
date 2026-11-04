import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AdvisorPanel } from '@/components/advisor-panel'
import { FindingsList } from '@/components/findings-list'
import { FixedToggle } from '@/components/fixed-toggle'
import { LeakMatrix } from '@/components/leak-matrix'
import { LiveRefresh, ScannedAgo } from '@/components/live'
import { ProjectHero } from '@/components/project-hero'
import { ScoreChart } from '@/components/score-chart'
import { TrustRow } from '@/components/trust-row'
import { advisorComparisonFor } from '@/lib/advisor'
import { fixedReferenceFor, type FixedReference } from '@/lib/fixed-reference'
import { personaFor, type Persona } from '@/lib/personas'
import { loadBackendScore, loadProject, type BackendScore, type ProjectView } from '@/lib/queries'
import { chartPoints } from '@/lib/series'
import { blockedCount, plainHeadline, replayLines, replaySignature } from '@/lib/story'
import type { ScanRun } from '@/lib/types'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
const LONG_DAYS = 14
const NO_FINDINGS = { critical: 0, high: 0, medium: 0, low: 0 }

type Params = Promise<{ readonly id: string }>

export const metadata: Metadata = { title: 'Red Row: project' }

function subline(run: ScanRun): string {
  const counted = run.critical + run.high + run.medium + run.low
  const findings = `${counted} ${counted === 1 ? 'finding' : 'findings'}`
  return `${findings} · ${run.tables_scanned} tables, ${run.probes_run} attacks, ${(run.duration_ms / 1000).toFixed(1)}s`
}

function Charts({ view }: { readonly view: ProjectView }) {
  const now = Date.now()
  const long = chartPoints(view.hourly, view.recent, now, LONG_DAYS * DAY_MS)
  const day = chartPoints(view.hourly, view.recent, now, DAY_MS)
  const hasSeeded = long.some((p) => p.seeded)
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.3em] text-dim">Score over time</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <ScoreChart title="Last 24 hours" points={day} from={now - DAY_MS} to={now} startLabel="24h ago" />
        <ScoreChart title={`Last ${LONG_DAYS} days`} points={long} from={now - LONG_DAYS * DAY_MS} to={now} startLabel={`${LONG_DAYS}d ago`} />
      </div>
      {hasSeeded ? (
        <p className="mt-2 text-sm text-dim">The dashed line is seeded demo history, backfilled from one real scan. The solid line is real scans.</p>
      ) : null}
    </section>
  )
}

type LiveProps = { readonly view: ProjectView; readonly run: ScanRun; readonly persona: Persona; readonly backend: BackendScore | null }

function LiveStory({ view, run, persona, backend }: LiveProps) {
  const { project, findings, probes } = view
  const comparison = advisorComparisonFor(project.name, run.score)
  return (
    <>
      <ProjectHero
        projectName={project.name}
        host={project.host_masked}
        score={run.score}
        grade={run.grade}
        headline={plainHeadline(probes, findings, persona)}
        subline={subline(run)}
        totals={run}
        lines={replayLines(probes, findings, persona)}
        blocked={blockedCount(probes)}
        replayKey={replaySignature(probes, run.score)}
        replayTitle="Attack replay, latest scan"
        aside={comparison === null ? null : <AdvisorPanel comparison={comparison} />}
      />
      <TrustRow backend={backend} />
      <LeakMatrix probes={probes} findings={findings} persona={persona} />
      <Charts view={view} />
      <FindingsList findings={findings} persona={persona} />
    </>
  )
}

type FixedProps = {
  readonly view: ProjectView
  readonly reference: FixedReference
  readonly persona: Persona
  readonly backend: BackendScore | null
}

function FixedStory({ view, reference, persona, backend }: FixedProps) {
  const date = new Date(reference.scannedAt).toISOString().slice(0, 10)
  return (
    <>
      <ProjectHero
        projectName={view.project.name}
        host={view.project.host_masked}
        score={reference.score}
        grade={reference.grade}
        headline="Every attack blocked."
        subline={`0 findings · ${reference.tablesScanned} tables, ${reference.probesRun} attacks`}
        totals={NO_FINDINGS}
        lines={[]}
        blocked={blockedCount(reference.probes)}
        replayKey="fixed"
        replayTitle="The same attacks, with the fix applied"
      />
      <p className="mt-3 text-sm text-dim">
        A real scan of this database with the fix applied, on {date}. The live demo stays leaky, so the attack can be shown again.
      </p>
      <TrustRow backend={backend} />
      <LeakMatrix probes={reference.probes} findings={[]} persona={persona} />
    </>
  )
}

export default async function ProjectPage({ params }: { readonly params: Params }) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const [view, backend] = await Promise.all([loadProject(id), loadBackendScore()])
  if (view === null) notFound()
  const { project, latest } = view
  const persona = personaFor(project.name)
  const reference = latest === null ? null : fixedReferenceFor(project.name, latest.score)
  return (
    <main>
      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Link href="/" className="text-sm text-dim hover:text-ink">
          ← All projects
        </Link>
        <div className="flex items-baseline gap-5">
          {latest === null ? null : <ScannedAgo at={latest.created_at} />}
          <LiveRefresh projectId={project.id} />
        </div>
      </div>
      {latest === null ? <p className="mt-10 text-xl text-dim">{project.name} has no scans yet.</p> : null}
      {latest !== null && reference === null ? <LiveStory view={view} run={latest} persona={persona} backend={backend} /> : null}
      {latest !== null && reference !== null ? (
        <FixedToggle
          live={<LiveStory view={view} run={latest} persona={persona} backend={backend} />}
          fixed={<FixedStory view={view} reference={reference} persona={persona} backend={backend} />}
        />
      ) : null}
    </main>
  )
}
