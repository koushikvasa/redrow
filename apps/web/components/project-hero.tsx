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
}

/** Numbers stand out in red in a leaking headline, because the numbers are the point. */
function Headline({ text, isClean }: { readonly text: string; readonly isClean: boolean }) {
  if (isClean) return <h1 className="mt-1 text-3xl font-bold leading-tight text-ok sm:text-4xl xl:text-[2.6rem]">{text}</h1>
  return (
    <h1 className="mt-1 text-2xl font-bold leading-snug sm:text-3xl xl:text-[2.3rem] xl:leading-[1.2]">
      {text.split(/(\d+)/).map((part, index) =>
        /^\d+$/.test(part) ? (
          <em key={index} className="font-bold not-italic text-leak">
            {part}
          </em>
        ) : (
          part
        ),
      )}
    </h1>
  )
}

export function ProjectHero({ projectName, host, score, grade, headline, subline, totals, lines, blocked, replayKey, replayTitle }: Props) {
  return (
    <section className="grid items-center gap-4 pt-2 lg:grid-cols-[380px_1fr] lg:gap-12">
      <div className="flex justify-center">
        <ScoreDial score={score} grade={grade} size="lg" />
      </div>
      <div className="min-w-0">
        <p className="w-fit text-sm text-dim" title={host}>
          {projectName}
        </p>
        <Headline text={headline} isClean={score >= 90} />
        <p className="mt-2 mb-4 text-sm text-dim">{subline}</p>
        <AttackReplay lines={lines} blocked={blocked} replayKey={replayKey} title={replayTitle} />
        <div className="mt-3">
          <SeverityCounts run={totals} compact />
        </div>
      </div>
    </section>
  )
}
