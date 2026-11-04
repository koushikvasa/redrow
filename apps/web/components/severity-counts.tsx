export type SeverityTotals = { readonly critical: number; readonly high: number; readonly medium: number; readonly low: number }

const LEVELS = [
  { key: 'critical', label: 'Critical', text: 'text-leak', top: 'border-t-leak' },
  { key: 'high', label: 'High', text: 'text-high', top: 'border-t-high' },
  { key: 'medium', label: 'Medium', text: 'text-amber', top: 'border-t-amber' },
  { key: 'low', label: 'Low', text: 'text-ink', top: 'border-t-dim' },
] as const

export function SeverityCounts({ run, compact = false }: { readonly run: SeverityTotals; readonly compact?: boolean }) {
  return (
    <div className="grid grid-cols-4 gap-2 sm:gap-3">
      {LEVELS.map(({ key, label, text, top }) => {
        const count = run[key]
        return (
          <div key={key} className={`min-w-0 border border-t-[3px] border-line bg-panel ${compact ? 'px-2 py-1.5 sm:px-3' : 'px-4 py-3'} ${count > 0 ? top : 'border-t-faint'}`}>
            <b className={`block font-bold leading-tight tabular-nums ${compact ? 'text-2xl sm:text-3xl' : 'text-5xl'} ${count > 0 ? text : 'text-faint'}`}>{count}</b>
            <span className="block truncate text-[0.6rem] uppercase text-dim sm:text-xs sm:tracking-[0.14em]">{label}</span>
          </div>
        )
      })}
    </div>
  )
}
