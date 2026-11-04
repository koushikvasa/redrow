import Link from 'next/link'
import { CopyButton } from '@/components/copy-button'
import { LiveRefresh, ScannedAgo } from '@/components/live'
import { ScoreDial } from '@/components/score-dial'
import { SeverityCounts } from '@/components/severity-counts'
import { TrustRow } from '@/components/trust-row'
import { loadBackendScore, loadBoard, type BoardCard } from '@/lib/queries'

export const dynamic = 'force-dynamic'

const REPO = 'https://github.com/koushikvasa/redrow'
const COMMAND = 'npm run scan -- --db "..." -y'

const BLURBS: Readonly<Record<string, string>> = {
  'CareNote demo': 'A clinic notes app, built to look AI-generated. It leaks on purpose.',
  'Red Row HQ (self-scan)': 'The database behind this page, attacked by its own tool.',
}

const STEPS = [
  'Signs in as a stranger and as real users',
  "Tries to read and change other people's rows",
  'Rolls everything back, scores it, writes the fix',
]

function Hero() {
  return (
    <section className="pt-8 pb-6 sm:pt-12">
      <h1 className="max-w-5xl text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl">
        AI wrote your RLS. <span className="text-leak">Red Row proves whether it leaks.</span>
      </h1>
      <p className="mt-4 max-w-3xl text-lg text-[#c9c8c2]">
        Row Level Security decides who can see which rows. Supabase&apos;s Security Advisor checks whether it&apos;s on. Red Row checks whether it works.
      </p>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <code className="border border-line bg-[#07080a] px-4 py-2 text-base text-[#a9d5b5] [overflow-wrap:anywhere] sm:text-lg">{COMMAND}</code>
        <CopyButton text={COMMAND} />
        <a href={REPO} className="border border-ink px-4 py-2 font-semibold hover:bg-ink hover:text-bg">
          Get it on GitHub
        </a>
      </div>
    </section>
  )
}

function HowItWorks() {
  return (
    <section aria-label="How it works">
      <ol className="grid border border-line bg-panel/60 md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-baseline gap-4 border-line px-5 py-4 not-first:border-t md:not-first:border-t-0 md:not-first:border-l">
            <span className="text-3xl font-bold leading-none tabular-nums text-faint">{index + 1}</span>
            <span className="leading-snug">{step}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ProjectCard({ card }: { readonly card: BoardCard }) {
  const { project, latest } = card
  return (
    <Link href={`/p/${project.id}`} className="group block border border-line bg-panel/60 p-5 hover:border-faint sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-xl font-bold group-hover:underline" title={project.host_masked}>
          {project.name}
        </h3>
        {latest === null ? <span className="text-sm text-dim">no scans yet</span> : <ScannedAgo at={latest.created_at} />}
      </div>
      <p className="mt-1 text-dim">{BLURBS[project.name] ?? 'A database Red Row watches.'}</p>
      {latest === null ? null : (
        <div className="mt-4 flex flex-col items-center gap-6 sm:flex-row">
          <ScoreDial score={latest.score} grade={latest.grade} size="sm" />
          <div className="w-full">
            <SeverityCounts run={latest} compact />
            <p className="mt-3 text-sm text-dim">
              {latest.tables_scanned} tables, {latest.probes_run} attacks, {(latest.duration_ms / 1000).toFixed(1)}s
            </p>
          </div>
        </div>
      )}
    </Link>
  )
}

export default async function BoardPage() {
  const [board, backend] = await Promise.all([loadBoard(), loadBackendScore()])
  return (
    <main>
      <Hero />
      <HowItWorks />
      <TrustRow backend={backend} />
      <div className="mt-6 mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-dim">Attacked about every minute</h2>
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
