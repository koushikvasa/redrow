export type SeverityTotals = { readonly critical: number; readonly high: number; readonly medium: number; readonly low: number }

// Only Critical takes the signal colour. The rest step down through ink.
const LEVELS = [
  { key: 'critical', label: 'Critical', text: 'text-leak', top: 'border-t-leak' },
  { key: 'high', label: 'High', text: 'text-ink', top: 'border-t-ink' },
  { key: 'medium', label: 'Medium', text: 'text-soft', top: 'border-t-dim' },
  { key: 'low', label: 'Low', text: 'text-dim', top: 'border-t-faint' },
] as const

export function SeverityCounts({ run, compact = false }: { readonly run: SeverityTotals; readonly compact?: boolean }) {
  return (
    <div className="grid grid-cols-4 border-y border-line">
      {LEVELS.map(({ key, label, text, top }) => {
        const count = run[key]
        return (
          <div key={key} className={`-mt-px min-w-0 border-t-2 not-first:border-l not-first:border-l-line ${compact ? 'px-2 py-1.5 sm:px-3' : 'px-4 py-3'} ${count > 0 ? top : 'border-t-line'}`}>
            <b className={`block font-display font-normal leading-tight tabular-nums ${compact ? 'text-[1.75rem] sm:text-[2rem]' : 'text-5xl'} ${count > 0 ? text : 'text-faint'}`}>{count}</b>
            <span className="block truncate font-mono text-[0.62rem] uppercase text-dim sm:text-xs sm:tracking-[0.12em]">{label}</span>
          </div>
        )
      })}
    </div>
  )
}
