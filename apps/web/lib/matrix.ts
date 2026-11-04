import type { FindingRow, ProbeRow } from './types'

/** `open` means the probe got through but no finding says that's a problem, such as a public board. */
export type CellState = 'leak' | 'open' | 'denied' | 'own' | 'declared' | 'na'

export interface MatrixCell {
  readonly column: string
  readonly state: CellState
  readonly count: number | null
  /** 0 to 1: how this leak's row count compares with the biggest in the matrix. */
  readonly heat: number
}

export interface MatrixRow {
  readonly table: string
  readonly cells: readonly MatrixCell[]
}

/** `rules`: the findings that make an allowed cell a leak. RLS being off (RR001, RR002) backs every cell. */
export const COLUMNS = [
  { id: 'anon-read', label: 'read', rules: ['RR101'], probes: [['anon', 'select_all']] },
  { id: 'anon-insert', label: 'insert', rules: ['RR106'], probes: [['anon', 'insert_other']] },
  { id: 'anon-update', label: 'update', rules: ['RR106'], probes: [['anon', 'update_any']] },
  { id: 'anon-delete', label: 'delete', rules: ['RR106'], probes: [['anon', 'delete_any']] },
  { id: 'own-read', label: 'read', rules: [], probes: [['user_a', 'select_own']] },
  { id: 'others-read', label: 'read', rules: ['RR102', 'RR003'], probes: [['user_a', 'select_others'], ['user_a', 'select_all']] },
  { id: 'others-insert', label: 'insert', rules: ['RR105'], probes: [['user_a', 'insert_other']] },
  { id: 'others-update', label: 'update', rules: ['RR103'], probes: [['user_a', 'update_other']] },
  { id: 'others-delete', label: 'delete', rules: ['RR104'], probes: [['user_a', 'delete_other']] },
] as const

const RLS_OFF_RULES: readonly string[] = ['RR001', 'RR002']

export const COLUMN_GROUPS = [
  { label: 'Anon', span: 4 },
  { label: 'User A, own', span: 1 },
  { label: 'User A → other users', span: 4 },
] as const

function cellFor(
  column: (typeof COLUMNS)[number],
  probes: readonly ProbeRow[],
  isDeclared: boolean,
  biggestLeak: number,
  counted: ReadonlySet<string>,
): MatrixCell {
  const probe = probes.find((p) => column.probes.some(([actor, action]) => p.actor === actor && p.action === action))
  const base = { column: column.id, count: probe?.row_count ?? null, heat: 0 }
  if (probe === undefined || probe.outcome === 'inconclusive' || probe.outcome === 'not_applicable') {
    return { ...base, state: 'na' }
  }
  if (probe.outcome === 'denied') return { ...base, state: 'denied' }
  if (column.id === 'own-read') return { ...base, state: 'own' }
  if (column.id === 'anon-read' && isDeclared) return { ...base, state: 'declared' }
  const isBacked = [...column.rules, ...RLS_OFF_RULES].some((rule) => counted.has(rule))
  if (!isBacked) return { ...base, state: 'open' }
  const count = probe.row_count ?? 1
  return { ...base, state: 'leak', heat: Math.log(count + 1) / Math.log(biggestLeak + 1) }
}

/** One row per table and one cell per column, from the latest scan's probes. Counts only. */
export function buildMatrix(probes: readonly ProbeRow[], findings: readonly FindingRow[]): MatrixRow[] {
  const tables = [...new Set(probes.map((p) => p.table_name))].sort()
  const declared = new Set(
    findings.filter((f) => f.severity === 'info' && f.rule_id === 'RR101').map((f) => f.table_name),
  )
  const biggestLeak = Math.max(1, ...probes.filter((p) => p.outcome === 'allowed').map((p) => p.row_count ?? 1))
  return tables.map((table) => {
    const own = probes.filter((p) => p.table_name === table)
    const counted = new Set(findings.filter((f) => f.severity !== 'info' && f.table_name === table).map((f) => f.rule_id))
    return { table, cells: COLUMNS.map((c) => cellFor(c, own, declared.has(table), biggestLeak, counted)) }
  })
}
