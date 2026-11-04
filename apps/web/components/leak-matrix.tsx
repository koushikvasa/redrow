import { COLUMNS, COLUMN_GROUPS, buildMatrix, type MatrixCell } from '@/lib/matrix'
import type { FindingRow, ProbeRow } from '@/lib/types'

const cellText = (cell: MatrixCell): string => {
  if (cell.state === 'denied') return '✕'
  if (cell.state === 'na') return '·'
  return cell.count === null ? '✔' : String(cell.count)
}

const LEGEND = [
  ['bg-leak', 'leak, with rows'],
  ['bg-ok', 'own rows, expected'],
  ['bg-ok/30', 'denied'],
  ['bg-[#1b1d22] border border-line', 'n/a or inconclusive'],
] as const

export function LeakMatrix({ probes, findings }: { readonly probes: readonly ProbeRow[]; readonly findings: readonly FindingRow[] }) {
  const rows = buildMatrix(probes, findings)
  if (rows.length === 0) return null
  const hasState = (state: MatrixCell['state']): boolean => rows.some((row) => row.cells.some((cell) => cell.state === state))
  const hasDeclared = hasState('declared')
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-dim">Leak matrix</h2>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-dim">
          {LEGEND.map(([swatch, label]) => (
            <li key={label} className="flex items-center gap-2">
              <i className={`inline-block size-3 ${swatch}`} />
              {label}
            </li>
          ))}
          {hasState('open') ? (
            <li className="flex items-center gap-2">
              <i className="inline-block size-3 bg-info/30" />
              allowed, not a finding
            </li>
          ) : null}
          {hasDeclared ? (
            <li className="flex items-center gap-2">
              <i className="inline-block size-3 bg-info" />
              meant to be public
            </li>
          ) : null}
        </ul>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1000px] table-fixed border-separate border-spacing-[3px]">
          <thead>
            <tr>
              <th className="w-[300px]" />
              {COLUMN_GROUPS.map((group) => (
                <th key={group.label} colSpan={group.span} scope="colgroup" className="border-b border-line pb-2 text-xs font-medium uppercase tracking-[0.14em]">
                  {group.label}
                </th>
              ))}
            </tr>
            <tr>
              <th />
              {COLUMNS.map((column) => (
                <th key={column.id} scope="col" className="py-1 text-sm font-medium text-dim">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.table}>
                <th scope="row" className="pr-3 text-left font-medium [overflow-wrap:anywhere]">
                  {row.table}
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.column} className={`cell cell-${cell.state}`} style={{ '--heat': cell.heat.toFixed(3) } as React.CSSProperties}>
                    {cellText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
