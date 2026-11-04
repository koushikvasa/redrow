import type { FindingRow, Severity } from '@/lib/types'
import { CopyButton } from './copy-button'

const GROUPS: readonly { readonly severity: Severity; readonly title: string; readonly color: string; readonly edge: string }[] = [
  { severity: 'critical', title: 'Critical', color: 'text-leak', edge: 'border-l-leak' },
  { severity: 'high', title: 'High', color: 'text-high', edge: 'border-l-high' },
  { severity: 'medium', title: 'Medium', color: 'text-amber', edge: 'border-l-amber' },
  { severity: 'low', title: 'Low', color: 'text-dim', edge: 'border-l-faint' },
  { severity: 'info', title: 'Declared exposure', color: 'text-info', edge: 'border-l-info' },
]

function FindingCard({ finding, edge }: { readonly finding: FindingRow; readonly edge: string }) {
  const where = finding.table_name === null ? finding.schema_name : `${finding.schema_name}.${finding.table_name}`
  return (
    <article className={`mb-2 border border-l-[3px] border-line bg-panel px-5 py-4 ${edge}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-bold">{finding.rule_id}</span>
        <span className="[overflow-wrap:anywhere]">{where}</span>
        <span className="text-dim">{finding.title}</span>
        {finding.rows_exposed === null ? null : (
          <span className="ml-auto text-sm tabular-nums text-dim">
            {finding.rows_exposed} {finding.rows_exposed === 1 ? 'row' : 'rows'}
          </span>
        )}
      </div>
      <p className="mt-2 text-[#c9c8c2] [overflow-wrap:anywhere]">{finding.detail}</p>
      <div className="mt-3 flex items-start gap-3">
        <code className="block min-w-0 flex-1 whitespace-pre-wrap border border-line bg-[#07080a] px-3 py-2 text-sm text-[#a9d5b5] [overflow-wrap:anywhere]">
          {finding.fix_hint}
        </code>
        <CopyButton text={finding.fix_hint} />
      </div>
    </article>
  )
}

export function FindingsList({ findings }: { readonly findings: readonly FindingRow[] }) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-dim">Findings</h2>
      {findings.length === 0 ? <p className="mt-4 text-xl text-ok">No findings.</p> : null}
      {GROUPS.map(({ severity, title, color, edge }) => {
        const group = findings.filter((f) => f.severity === severity).sort((a, b) => a.rule_id.localeCompare(b.rule_id))
        if (group.length === 0) return null
        return (
          <div key={severity} className="mt-6">
            <h3 className={`mb-3 flex items-baseline gap-3 text-xl font-bold ${color}`}>
              {title} <small className="text-base font-normal text-dim">{group.length}</small>
            </h3>
            {group.map((finding) => (
              <FindingCard key={finding.id} finding={finding} edge={edge} />
            ))}
          </div>
        )
      })}
    </section>
  )
}
