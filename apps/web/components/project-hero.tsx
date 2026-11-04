import type { ReactNode } from 'react'
import type { ReplayLine } from '@/lib/story'
import { AttackReplay } from './attack-replay'
import { ScoreDial } from './score-dial'
import { SeverityCounts, type SeverityTotals } from './severity-counts'

type Props = {
  readonly projectName: string
  /** Only on hover: it adds nothing for someone reading the story. */
  readonly host: string
  readonly score: number
  readonly grade: string
  readonly headline: string
  readonly subline: string
  readonly totals: SeverityTotals
  readonly lines: readonly ReplayLine[]
  readonly blocked: number
  readonly replayKey: string
  readonly replayTitle: string
  readonly aside?: ReactNode
}

/** Numbers stand out in red in a leaking headline, because the numbers are the point. */
function Headline({ text, isClean }: { readonly text: string; readonly isClean: boolean }) {
  if (isClean) return <h1 className="mt-1 font-display text-[2.5rem] leading-[1.05] sm:text-6xl 2xl:text-7xl">{text}</h1>
  return (
    <h1 className="mt-1 font-display text-[1.75rem] leading-[1.14] sm:text-[2.25rem] 2xl:text-[2.75rem]">
      {text.split(/(\d+)/).map((part, index) =>
        /^\d+$/.test(part) ? (
          <em key={index} className="not-italic text-leak">
            {part}
          </em>
        ) : (
          part
        ),
      )}
    </h1>
  )
}

export function ProjectHero({ projectName, host, score, grade, headline, subline, totals, lines, blocked, replayKey, replayTitle, aside }: Props) {
  const storyLayout = aside ? 'xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] xl:items-start xl:gap-8 2xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]' : ''
  return (
    <section className="grid items-start gap-4 pt-2 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-8 2xl:grid-cols-[360px_minmax(0,1fr)] 2xl:gap-12">
      <div className="flex justify-center lg:sticky lg:top-6">
        <ScoreDial score={score} grade={grade} size="lg" hasOpenDoors={totals.critical > 0 || lines.length > 0} />
      </div>
      <div className={`min-w-0 ${storyLayout}`}>
        <div className="min-w-0">
          <p className="eyebrow w-fit" title={host}>
            {projectName}
          </p>
          <Headline text={headline} isClean={score >= 90} />
          <p className="mt-3 mb-4 font-mono text-sm text-dim">{subline}</p>
          <AttackReplay lines={lines} blocked={blocked} replayKey={replayKey} title={replayTitle} />
          <div className="mt-3">
            <SeverityCounts run={totals} compact />
          </div>
        </div>
        {aside ? <div className="mt-4 min-w-0 xl:mt-0">{aside}</div> : null}
      </div>
    </section>
  )
}
