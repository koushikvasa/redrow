import type { Report, ReportFinding } from './report'
import { RULES } from './rules'
import type { ProbeAction, ProbeActor, ProbeOutcome, Severity } from './types'
import { ENGINE_VERSION } from './version'

/** `seed` marks backfilled history, so nothing can mistake it for a real scan. */
export type ScanSource = 'cli' | 'sweep' | 'ci' | 'dashboard' | 'seed'

export interface ScanRunRow {
  readonly project_id: string
  readonly source: ScanSource
  readonly engine_version: string
  readonly score: number
  readonly grade: string
  readonly critical: number
  readonly high: number
  readonly medium: number
  readonly low: number
  readonly tables_scanned: number
  readonly probes_run: number
  readonly duration_ms: number
}

export interface FindingRow {
  readonly project_id: string
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
  readonly project_id: string
  readonly table_name: string
  readonly actor: ProbeActor
  readonly action: ProbeAction
  readonly outcome: ProbeOutcome
  readonly row_count: number | null
}

export interface ScanRows {
  readonly run: ScanRunRow
  readonly findings: readonly FindingRow[]
  readonly probes: readonly ProbeRow[]
}

const ruleTitle = (id: string): string =>
  (RULES as Readonly<Record<string, { readonly title: string } | undefined>>)[id]?.title ?? id

const toFindingRow = (finding: ReportFinding, projectId: string): FindingRow => ({
  project_id: projectId,
  rule_id: finding.id,
  severity: finding.severity,
  schema_name: finding.evidence.schema,
  table_name: finding.table,
  title: ruleTitle(finding.id),
  detail: finding.description,
  rows_exposed: finding.evidence.kind === 'probe' ? finding.evidence.rowCount : null,
  fix_hint: finding.remediation,
})

/** A report as HQ's insert-only tables hold it. Counts and catalog text only, as in the report. */
export function toScanRows(report: Report, projectId: string, source: ScanSource): ScanRows {
  const { summary } = report
  return {
    run: {
      project_id: projectId,
      source,
      engine_version: ENGINE_VERSION,
      score: summary.score,
      grade: summary.grade,
      critical: summary.bySeverity.critical,
      high: summary.bySeverity.high,
      medium: summary.bySeverity.medium,
      low: summary.bySeverity.low,
      tables_scanned: summary.tablesScanned,
      probes_run: summary.probesRun,
      duration_ms: summary.durationMs,
    },
    findings: report.findings.map((finding) => toFindingRow(finding, projectId)),
    probes: summary.probes.map((probe) => ({
      project_id: projectId,
      table_name: probe.table,
      actor: probe.actor,
      action: probe.action,
      outcome: probe.outcome,
      row_count: probe.rowCount,
    })),
  }
}
