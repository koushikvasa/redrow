import type { FindingRow, ProbeRow } from './types'

export type CellState = 'leak' | 'denied' | 'own' | 'declared' | 'na'

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

export const COLUMNS = [
  { id: 'anon-read', label: 'read', probes: [['anon', 'select_all']] },
  { id: 'anon-insert', label: 'insert', probes: [['anon', 'insert_other']] },
  { id: 'anon-update', label: 'update', probes: [['anon', 'update_any']] },
  { id: 'anon-delete', label: 'delete', probes: [['anon', 'delete_any']] },
  { id: 'own-read', label: 'read', probes: [['user_a', 'select_own']] },
  { id: 'others-read', label: 'read', probes: [['user_a', 'select_others'], ['user_a', 'select_all']] },
  { id: 'others-insert', label: 'insert', probes: [['user_a', 'insert_other']] },
  { id: 'others-update', label: 'update', probes: [['user_a', 'update_other']] },
  { id: 'others-delete', label: 'delete', probes: [['user_a', 'delete_other']] },
] as const

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
): MatrixCell {
  const probe = probes.find((p) => column.probes.some(([actor, action]) => p.actor === actor && p.action === action))
  const base = { column: column.id, count: probe?.row_count ?? null, heat: 0 }
  if (probe === undefined || probe.outcome === 'inconclusive' || probe.outcome === 'not_applicable') {
    return { ...base, state: 'na' }
  }
  if (probe.outcome === 'denied') return { ...base, state: 'denied' }
  if (column.id === 'own-read') return { ...base, state: 'own' }
  if (column.id === 'anon-read' && isDeclared) return { ...base, state: 'declared' }
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
    return { table, cells: COLUMNS.map((c) => cellFor(c, own, declared.has(table), biggestLeak)) }
  })
}
