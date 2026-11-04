import type { Persona } from '@/lib/personas'
import { groupFindings, type FindingCard } from '@/lib/story'
import type { FindingRow, Severity } from '@/lib/types'
import { CopyButton } from './copy-button'

// Only Critical takes the signal colour. The rest step down through ink.
const SEVERITY_STYLE: Readonly<Record<Severity, { readonly label: string; readonly badge: string; readonly edge: string }>> = {
  critical: { label: 'Critical', badge: 'border-leak text-leak', edge: 'border-l-leak' },
  high: { label: 'High', badge: 'border-ink text-ink', edge: 'border-l-ink' },
  medium: { label: 'Medium', badge: 'border-dim text-soft', edge: 'border-l-dim' },
  low: { label: 'Low', badge: 'border-line-strong text-dim', edge: 'border-l-faint' },
  info: { label: 'Declared', badge: 'border-line-strong text-dim', edge: 'border-l-line-strong' },
}

function Fix({ hint }: { readonly hint: string }) {
  return (
    <details className="group mt-2">
      <summary className="w-fit cursor-pointer text-sm text-dim hover:text-ink">Show the fix</summary>
      <div className="mt-2 flex items-start gap-3">
        <code className="block min-w-0 flex-1 whitespace-pre-wrap border border-line bg-sunken px-3 py-2 text-sm text-soft [overflow-wrap:anywhere]">
          {hint}
        </code>
        <CopyButton text={hint} />
      </div>
    </details>
  )
}

function SubFinding({ finding }: { readonly finding: FindingRow }) {
  return (
    <li className="border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{finding.detail}</p>
        <span className="whitespace-nowrap font-mono text-xs text-dim">{finding.rule_id}</span>
      </div>
      <Fix hint={finding.fix_hint} />
    </li>
  )
}

function TableCard({ card }: { readonly card: FindingCard }) {
  const style = SEVERITY_STYLE[card.worst]
  const problems = card.problems === 0 ? '' : `, ${card.problems} ${card.problems === 1 ? 'problem' : 'problems'}`
  return (
    <article className={`lift mb-3 border border-l-[3px] border-line bg-panel px-4 py-4 sm:px-5 ${style.edge}`}>
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`border px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-[0.1em] ${style.badge}`}>{style.label}</span>
        <h3 className="font-display text-xl [overflow-wrap:anywhere]">
          {card.title}: <span className="text-soft">{`${card.phrase}${problems}`}</span>
        </h3>
      </header>
      <ul>
        {/* By position, not row id: every scan has new ids, and an opened fix should stay open. */}
        {card.findings.map((finding, index) => (
          <SubFinding key={`${finding.rule_id}-${index}`} finding={finding} />
        ))}
      </ul>
    </article>
  )
}

function Hints({ hints }: { readonly hints: readonly FindingRow[] }) {
  return (
    <details className="mt-5 border border-line bg-panel px-4 py-3 sm:px-5">
      <summary className="cursor-pointer font-semibold text-dim hover:text-ink">Performance hints ({hints.length})</summary>
      <ul className="mt-3">
        {hints.map((finding, index) => (
          <SubFinding key={`${finding.rule_id}-${index}`} finding={finding} />
        ))}
      </ul>
    </details>
  )
}

export function FindingsList({ findings, persona }: { readonly findings: readonly FindingRow[]; readonly persona: Persona }) {
  const { cards, hints } = groupFindings(findings, persona)
  return (
    <section className="mt-10">
      <h2 className="section-head eyebrow mb-4">Findings, by table</h2>
      {findings.length === 0 ? <p className="font-display text-2xl">No findings.</p> : null}
      {cards.map((card) => (
        <TableCard key={card.key} card={card} />
      ))}
      {hints.length > 0 ? <Hints hints={hints} /> : null}
    </section>
  )
}
