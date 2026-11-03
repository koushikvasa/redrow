import type { RuleId } from './rules'

export type Severity = 'critical' | 'high' | 'medium' | 'low'
export type Grade = 'A' | 'B' | 'C' | 'D' | 'F'

export type SeverityCounts = Readonly<Record<Severity, number>>

export interface Finding {
  readonly ruleId: RuleId
  readonly severity: Severity
  readonly schema: string
  /** Table or view the finding is about. Absent for schema-level objects such as functions. */
  readonly table?: string
  readonly title: string
  readonly detail: string
  readonly rowsExposed?: number
  readonly fixHint: string
}

// Probe vocabulary matches the check constraints on HQ's probe_results (docs/SCHEMAS.md).
export type ProbeActor = 'anon' | 'user_a' | 'user_b'
export type ProbeAction =
  | 'select_own'
  | 'select_others'
  | 'select_all'
  | 'insert_other'
  | 'update_other'
  | 'delete_other'
  | 'update_any'
  | 'delete_any'
export type ProbeOutcome = 'allowed' | 'denied' | 'inconclusive' | 'not_applicable'

export interface ProbeResult {
  readonly table: string
  readonly actor: ProbeActor
  readonly action: ProbeAction
  readonly outcome: ProbeOutcome
  readonly rowCount: number | null
}

export interface TableSummary {
  readonly schema: string
  readonly table: string
  readonly rlsEnabled: boolean
  readonly ownerColumn?: string
  readonly totalRows: number
  readonly sensitive: readonly string[]
}

/** The JSON report, and what `--upload` sends. ENGINE.md §5. */
export interface ScanResult {
  readonly engineVersion: string
  readonly startedAt: string
  readonly durationMs: number
  readonly target: { readonly host: string; readonly schemas: readonly string[] }
  readonly score: number
  readonly grade: Grade
  readonly counts: SeverityCounts
  readonly tables: readonly TableSummary[]
  readonly findings: readonly Finding[]
  readonly probes: readonly ProbeResult[]
  /** Uuids only. */
  readonly actors: { readonly userA: string; readonly userB: string }
}

export interface ScanOptions {
  /** Defaults to `['public']`. */
  readonly schemas?: readonly string[]
  /** Skips every write probe. */
  readonly readOnly?: boolean
  /** Table name to owner column, from `redrow.config.json`. Wins over detection. */
  readonly ownerColumns?: Readonly<Record<string, string>>
}

export interface TablePrivileges {
  readonly select: boolean
  readonly insert: boolean
  readonly update: boolean
  readonly delete: boolean
}

export interface ColumnInfo {
  readonly attnum: number
  readonly name: string
  readonly type: string
  /** True when the column leads at least one index. */
  readonly indexed: boolean
}

export interface TableInfo {
  readonly oid: number
  readonly schema: string
  readonly table: string
  readonly rlsEnabled: boolean
  readonly rlsForced: boolean
  readonly anon: TablePrivileges
  readonly authenticated: TablePrivileges
  readonly columns: readonly ColumnInfo[]
  readonly ownerColumn?: string
  readonly sensitive: readonly string[]
}

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

export interface PolicyInfo {
  readonly schema: string
  readonly table: string
  readonly name: string
  readonly permissive: boolean
  readonly roles: readonly string[]
  readonly cmd: PolicyCommand
  /** USING expression, as normalized by `pg_policies`. */
  readonly qual: string | null
  /** WITH CHECK expression, as normalized by `pg_policies`. */
  readonly withCheck: string | null
}

export interface ViewInfo {
  readonly schema: string
  readonly view: string
  readonly materialized: boolean
  readonly securityInvoker: boolean
  readonly anonSelect: boolean
  readonly authSelect: boolean
}

export interface SecurityDefinerFunction {
  readonly schema: string
  readonly name: string
  readonly args: string
  readonly anonExec: boolean
  readonly authExec: boolean
}

export interface Introspection {
  readonly tables: readonly TableInfo[]
  readonly policies: readonly PolicyInfo[]
  readonly views: readonly ViewInfo[]
  readonly functions: readonly SecurityDefinerFunction[]
}
