import Link from 'next/link'
import { CopyButton } from '@/components/copy-button'
import { LiveRefresh, ScannedAgo } from '@/components/live'
import { RealWorldSection } from '@/components/real-world-section'
import { ScoreDial } from '@/components/score-dial'
import { SeverityCounts } from '@/components/severity-counts'
import { TrustRow } from '@/components/trust-row'
import { loadBackendScore, loadBoard, type BoardCard } from '@/lib/queries'

export const dynamic = 'force-dynamic'

const REPO = 'https://github.com/koushikvasa/redrow'
const COMMAND = 'npx redrow scan --db "<session pooler url>" --read-only -y'

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
    <section className="grid gap-6 pt-8 pb-8 sm:pt-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:items-end lg:gap-14">
      <h1 className="font-display text-[clamp(2.75rem,6.2vw,7rem)] leading-[1] tracking-[-0.01em]">
        <span className="text-dim">AI wrote your RLS.</span> Red Row proves whether it leaks.
      </h1>
      <div>
        <p className="text-lg leading-snug text-soft 2xl:text-xl">
          Row Level Security decides who can see which rows. Supabase&apos;s Security Advisor checks whether it&apos;s on. Red Row checks whether it works.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <code className="min-w-0 border border-line bg-sunken px-3 py-2 text-sm text-ink [overflow-wrap:anywhere] 2xl:text-base">{COMMAND}</code>
          <CopyButton text={COMMAND} />
          <a href={REPO} className="border border-ink bg-ink px-4 py-2 text-sm font-semibold text-bg transition-colors hover:bg-transparent hover:text-ink">
            Get it on GitHub
          </a>
        </div>
        <p className="mt-2 text-sm text-dim">Find your Session pooler URL in Supabase, under Connect. Needs Node 20.12+.</p>
      </div>
    </section>
  )
}

function HowItWorks() {
  return (
    <section aria-label="How it works">
      <ol className="grid border-t-2 border-ink md:grid-cols-3">
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-baseline gap-4 border-line py-4 not-first:border-t md:px-5 md:first:pl-0 md:not-first:border-t-0 md:not-first:border-l">
            <span className="font-display text-4xl leading-none tabular-nums text-faint">{index + 1}</span>
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
    <Link href={`/p/${project.id}`} className="lift group block border border-line bg-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-2xl underline-offset-4 group-hover:underline" title={project.host_masked}>
          {project.name}
        </h3>
        {latest === null ? <span className="font-mono text-sm text-dim">no scans yet</span> : <ScannedAgo at={latest.created_at} />}
      </div>
      <p className="mt-1 text-soft">{BLURBS[project.name] ?? 'A database Red Row watches.'}</p>
      {latest === null ? null : (
        <div className="mt-4 flex flex-col items-center gap-6 sm:flex-row">
          <ScoreDial score={latest.score} grade={latest.grade} size="sm" hasOpenDoors={latest.critical > 0} />
          <div className="w-full">
            <SeverityCounts run={latest} compact />
            <p className="mt-3 font-mono text-sm text-dim">
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
      <div className="mt-8 mb-3 flex items-baseline justify-between gap-4">
        <h2 className="eyebrow">Attacked about every minute</h2>
        <LiveRefresh />
      </div>
      <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
        {board.map((card) => (
          <ProjectCard key={card.project.id} card={card} />
        ))}
      </div>
      <RealWorldSection />
    </main>
  )
}
