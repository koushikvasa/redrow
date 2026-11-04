import { REAL_WORLD_APPS, type Assessment, type RealWorldApp } from '@/lib/real-world'
import { ScoreDial } from './score-dial'

const TAG_CLASS: Readonly<Record<Assessment, string>> = {
  'likely leak': 'border-leak text-leak',
  'intended sharing': 'border-line text-dim',
  'needs review': 'border-ink text-ink',
}

function RealWorldCard({ app }: { readonly app: RealWorldApp }) {
  return (
    <article className="flex flex-col border border-line bg-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h3 className="font-display text-2xl">{app.name}</h3>
        <span className={`border px-2 py-0.5 font-mono text-xs ${TAG_CLASS[app.assessment]}`}>{app.assessment}</span>
      </div>
      <p className="mt-1 text-sm text-dim">{app.purpose}</p>
      <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        <ScoreDial score={app.score} grade={app.grade} size="sm" hasOpenDoors={app.critical > 0} />
        <div className="w-full">
          <p className="leading-snug text-soft">{app.summary}</p>
          <a href={`/real-world/${app.file}`} className="mt-3 inline-block text-sm font-semibold underline underline-offset-4 hover:text-dim">
            Open full report
          </a>
        </div>
      </div>
    </article>
  )
}

export function RealWorldSection() {
  return (
    <section aria-labelledby="real-world-heading" className="mt-10">
      <h2 id="real-world-heading" className="eyebrow mb-3">
        Tonight&apos;s real-world runs: teammates built apps with AI tools and ran npx redrow
      </h2>
      <div className="grid gap-4 lg:grid-cols-3 lg:gap-6">
        {REAL_WORLD_APPS.map((app) => (
          <RealWorldCard key={app.file} app={app} />
        ))}
      </div>
      <p className="mt-3 text-sm text-dim">Assessment is our judgment of intent; Red Row reports access.</p>
    </section>
  )
}
