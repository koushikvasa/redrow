import type { ScanRun } from '@/lib/types'

const LEVELS = [
  { key: 'critical', label: 'Critical', text: 'text-leak', top: 'border-t-leak' },
  { key: 'high', label: 'High', text: 'text-high', top: 'border-t-high' },
  { key: 'medium', label: 'Medium', text: 'text-amber', top: 'border-t-amber' },
  { key: 'low', label: 'Low', text: 'text-ink', top: 'border-t-dim' },
] as const

export function SeverityCounts({ run, compact = false }: { readonly run: ScanRun; readonly compact?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {LEVELS.map(({ key, label, text, top }) => {
        const count = run[key]
        return (
          <div key={key} className={`border border-t-[3px] border-line bg-panel ${compact ? 'px-3 py-2' : 'px-4 py-3'} ${count > 0 ? top : 'border-t-faint'}`}>
            <b className={`block font-bold leading-tight tabular-nums ${compact ? 'text-3xl' : 'text-5xl'} ${count > 0 ? text : 'text-faint'}`}>{count}</b>
            <span className="text-xs uppercase tracking-[0.14em] text-dim">{label}</span>
          </div>
        )
      })}
    </div>
  )
}
