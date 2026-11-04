import Link from 'next/link'
import { CopyButton } from '@/components/copy-button'
import { LiveRefresh, ScannedAgo } from '@/components/live'
import { ScoreDial } from '@/components/score-dial'
import { SeverityCounts } from '@/components/severity-counts'
import { loadBoard, type BoardCard } from '@/lib/queries'

export const dynamic = 'force-dynamic'

const REPO = 'https://github.com/koushikvasa/redrow'
const COMMAND = 'npm run scan -- --db "..." -y'

const BLURBS: Readonly<Record<string, string>> = {
  'CareNote demo': 'A clinic notes app, built to look AI-generated. It leaks on purpose.',
  'Red Row HQ (self-scan)': "The database behind this page, attacked by its own tool. Its board is meant to be public.",
}

function Hero() {
  return (
    <section className="py-10 sm:py-14">
      <h1 className="max-w-5xl text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl">
        AI wrote your RLS. <span className="text-leak">Red Row proves whether it leaks.</span>
      </h1>
      <p className="mt-5 max-w-3xl text-lg text-[#c9c8c2]">
        Supabase&apos;s Security Advisor checks whether RLS is on. Red Row checks whether it works: it signs in as anon and as real
        users, tries to read and change other people&apos;s rows, and reports what it managed to do.
      </p>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <code className="border border-line bg-[#07080a] px-4 py-2 text-lg text-[#a9d5b5] [overflow-wrap:anywhere]">{COMMAND}</code>
        <CopyButton text={COMMAND} />
        <a href={REPO} className="border border-ink px-4 py-2 font-semibold hover:bg-ink hover:text-bg">
          Get it on GitHub
        </a>
      </div>
    </section>
  )
}

function ProjectCard({ card }: { readonly card: BoardCard }) {
  const { project, latest } = card
  return (
    <Link href={`/p/${project.id}`} className="group block border border-line bg-panel/60 p-5 hover:border-faint sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-xl font-bold group-hover:underline">{project.name}</h3>
        {latest === null ? <span className="text-sm text-dim">no scans yet</span> : <ScannedAgo at={latest.created_at} />}
      </div>
      <p className="mt-1 text-dim">{BLURBS[project.name] ?? project.host_masked}</p>
      {latest === null ? null : (
        <div className="mt-4 flex flex-col items-center gap-6 sm:flex-row">
          <ScoreDial score={latest.score} grade={latest.grade} size="sm" />
          <div className="w-full">
            <SeverityCounts run={latest} compact />
            <p className="mt-3 text-sm text-dim">
              {latest.tables_scanned} tables, {latest.probes_run} probes, {(latest.duration_ms / 1000).toFixed(1)}s
            </p>
          </div>
        </div>
      )}
    </Link>
  )
}

export default async function BoardPage() {
  const board = await loadBoard()
  return (
    <main>
      <Hero />
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-dim">Attacked every minute</h2>
        <LiveRefresh />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {board.map((card) => (
          <ProjectCard key={card.project.id} card={card} />
        ))}
      </div>
    </main>
  )
}
