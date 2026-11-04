export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export interface Project {
  readonly id: string
  readonly name: string
  readonly host_masked: string
}

export interface ScanRun {
  readonly id: string
  readonly source: string
  readonly score: number
  readonly grade: string
  readonly critical: number
  readonly high: number
  readonly medium: number
  readonly low: number
  readonly tables_scanned: number
  readonly probes_run: number
  readonly duration_ms: number
  readonly created_at: string
}

export interface FindingRow {
  readonly id: string
  readonly rule_id: string
  readonly severity: Severity
  readonly schema_name: string
  readonly table_name: string | null
  readonly title: string
  readonly detail: string
  readonly rows_exposed: number | null
  readonly fix_hint: string
}

export interface ProbeRow {
  readonly table_name: string
  readonly actor: string
  readonly action: string
  readonly outcome: string
  readonly row_count: number | null
}

export interface HourlyScore {
  readonly hour: string
  readonly score: number
  readonly seeded: boolean
}

export interface RecentScore {
  readonly score: number
  readonly source: string
  readonly created_at: string
}
