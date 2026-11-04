import type { ReactNode } from 'react'
import { COLUMNS, buildMatrix, columnGroups, type MatrixCell } from '@/lib/matrix'
import type { Persona } from '@/lib/personas'
import type { FindingRow, ProbeRow } from '@/lib/types'
import { LockIcon } from './lock-icon'

const CELL_WORDS: Readonly<Record<MatrixCell['state'], string>> = {
  leak: 'got through',
  open: 'allowed, not a finding',
  declared: 'public on purpose',
  own: 'own rows',
  denied: 'blocked',
  na: 'not tested',
}

function CellContent({ cell }: { readonly cell: MatrixCell }) {
  const count = cell.count === null ? null : <span>{cell.count}</span>
  if (cell.state === 'denied') return <LockIcon isOpen={false} />
  if (cell.state === 'na') return <span>·</span>
  if (cell.state === 'own') return count ?? <LockIcon isOpen />
  return (
    <>
      <LockIcon isOpen />
      {count}
    </>
  )
}

const LegendItem = ({ icon, children }: { readonly icon: ReactNode; readonly children: ReactNode }) => (
  <li className="flex items-center gap-2">
    {icon}
    {children}
  </li>
)

function Legend({ hasOpen, hasDeclared }: { readonly hasOpen: boolean; readonly hasDeclared: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-dim">
      <LegendItem icon={<LockIcon isOpen className="text-leak" />}>got through, with rows</LegendItem>
      <LegendItem icon={<LockIcon isOpen={false} className="text-ok/70" />}>blocked</LegendItem>
      <LegendItem icon={<b className="text-ok">40</b>}>own rows, expected</LegendItem>
      {hasOpen ? <LegendItem icon={<LockIcon isOpen className="text-info" />}>allowed, not a finding</LegendItem> : null}
      {hasDeclared ? <LegendItem icon={<i className="inline-block size-3 bg-info" />}>public on purpose</LegendItem> : null}
    </ul>
  )
}

type Props = {
  readonly probes: readonly ProbeRow[]
  readonly findings: readonly FindingRow[]
  readonly persona: Persona
}

export function LeakMatrix({ probes, findings, persona }: Props) {
  const rows = buildMatrix(probes, findings)
  if (rows.length === 0) return null
  const hasState = (state: MatrixCell['state']): boolean => rows.some((row) => row.cells.some((cell) => cell.state === state))
  return (
    <section className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.3em] text-dim">Who got into what</h2>
        <Legend hasOpen={hasState('open')} hasDeclared={hasState('declared')} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-[3px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 w-[112px] bg-bg sm:w-[200px] lg:w-[260px]" />
              {columnGroups(persona).map((group) => (
                <th key={group.label} colSpan={group.span} scope="colgroup" className="border-b border-line px-1 pb-2 align-bottom text-xs font-medium tracking-[0.04em]">
                  {group.label}
                </th>
              ))}
            </tr>
            <tr>
              <th className="sticky left-0 z-10 bg-bg" />
              {COLUMNS.map((column) => (
                <th key={column.id} scope="col" className="py-1 text-xs font-medium text-dim sm:text-sm">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.table}>
                <th scope="row" className="sticky left-0 z-10 bg-bg pr-2 text-left text-sm font-medium [overflow-wrap:anywhere] sm:text-base">
                  {row.table}
                </th>
                {row.cells.map((cell) => (
                  <td
                    key={cell.column}
                    aria-label={`${CELL_WORDS[cell.state]}${cell.count === null ? '' : `, ${cell.count} rows`}`}
                    className={`cell cell-${cell.state}`}
                    style={{ '--heat': cell.heat.toFixed(3) } as React.CSSProperties}
                  >
                    <span className="inline-flex items-center justify-center gap-1.5 align-middle">
                      <CellContent cell={cell} />
                    </span>
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
