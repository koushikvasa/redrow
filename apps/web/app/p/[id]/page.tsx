import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { FindingsList } from '@/components/findings-list'
import { LeakMatrix } from '@/components/leak-matrix'
import { LiveRefresh, ScannedAgo } from '@/components/live'
import { ScoreChart } from '@/components/score-chart'
import { ScoreDial } from '@/components/score-dial'
import { SeverityCounts } from '@/components/severity-counts'
import { loadProject, type ProjectView } from '@/lib/queries'
import { chartPoints } from '@/lib/series'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 86_400_000
const LONG_DAYS = 14

type Params = Promise<{ readonly id: string }>

export const metadata: Metadata = { title: 'Red Row: project' }

function verdict(view: ProjectView): string {
  const counted = view.latest === null ? 0 : view.latest.critical + view.latest.high + view.latest.medium + view.latest.low
  if (counted === 0) return 'No leaks proven.'
  return `${counted} ${counted === 1 ? 'finding' : 'findings'}. ${view.latest?.score === 0 ? 'This database leaks.' : 'Still leaking.'}`
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

export default async function ProjectPage({ params }: { readonly params: Params }) {
  const { id } = await params
  if (!UUID.test(id)) notFound()
  const view = await loadProject(id)
  if (view === null) notFound()
  const { project, latest, findings, probes } = view
  return (
    <main>
      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Link href="/" className="text-sm text-dim hover:text-ink">
          ← All projects
        </Link>
        <div className="flex items-baseline gap-5">
          {latest === null ? null : <ScannedAgo at={latest.created_at} />}
          <LiveRefresh projectId={project.id} />
        </div>
      </div>
      {latest === null ? (
        <p className="mt-10 text-xl text-dim">{project.name} has no scans yet.</p>
      ) : (
        <>
          <section className="grid items-center gap-8 py-6 lg:grid-cols-[380px_1fr] lg:gap-14">
            <div className="flex justify-center">
              <ScoreDial score={latest.score} grade={latest.grade} size="lg" />
            </div>
            <div>
              <p className="text-dim [overflow-wrap:anywhere]">
                {project.name} · {project.host_masked}
              </p>
              <h1 className={`mt-1 mb-5 text-4xl font-bold leading-tight sm:text-5xl ${latest.score >= 90 ? 'text-ok' : ''}`}>{verdict(view)}</h1>
              <SeverityCounts run={latest} />
              <p className="mt-3 text-sm text-dim">
                {latest.tables_scanned} tables, {latest.probes_run} probes, {(latest.duration_ms / 1000).toFixed(1)}s, from {latest.source}
              </p>
            </div>
          </section>
          <LeakMatrix probes={probes} findings={findings} />
          <Charts view={view} />
          <FindingsList findings={findings} />
        </>
      )}
    </main>
  )
}
