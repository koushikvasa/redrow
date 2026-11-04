import { SEVERITIES } from './score'
import type { Finding, Grade, ProbeEvidence, ProbeResult, ScanResult, Severity, SeverityCounts } from './types'

/**
 * The public JSON contract that `redrow scan --json` emits and H5/H6 consume.
 * Bump this for any breaking change.
 */
export const REPORT_VERSION = 1

export type ReportEvidence =
  | ({ readonly kind: 'probe'; readonly schema: string } & ProbeEvidence)
  | { readonly kind: 'catalog'; readonly schema: string }

export interface ReportFinding {
  /** Rule id, such as `RR102`. */
  readonly id: string
  readonly severity: Severity
  readonly table: string | null
  readonly policy: string | null
  /** `actor:action`, such as `user_a:select_others`. Null for catalog findings. */
  readonly probe: string | null
  /** What a caller could actually do. */
  readonly description: string
  readonly evidence: ReportEvidence
  readonly remediation: string
}

export interface ReportSummary {
  /** Findings that count against the score. Declared exposure is only in `bySeverity.info`. */
  readonly total: number
  readonly bySeverity: SeverityCounts
  readonly score: number
  readonly grade: Grade
  readonly tablesScanned: number
  readonly probesRun: number
  readonly durationMs: number
  /** Every probe that ran, including denied ones: the leak matrix. Counts only. */
  readonly probes: readonly ProbeResult[]
  /** Probes that proved nothing either way, so "no findings" doesn't cover them. */
  readonly inconclusive: number
  /** Reasons this report may understate the leaks. */
  readonly warnings: readonly string[]
}

export interface Report {
  readonly version: number
  readonly scannedAt: string
  /** No credentials or user names, ever. */
  readonly database: {
    readonly host: string
    readonly name: string
    readonly schemas: readonly string[]
  }
  readonly findings: readonly ReportFinding[]
  readonly summary: ReportSummary
}

function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
    a.ruleId.localeCompare(b.ruleId) ||
    (a.table ?? '').localeCompare(b.table ?? '')
  )
}

const toReportFinding = (finding: Finding): ReportFinding => ({
  id: finding.ruleId,
  severity: finding.severity,
  table: finding.table ?? null,
  policy: finding.policy ?? null,
  probe: finding.probe === undefined ? null : `${finding.probe.actor}:${finding.probe.action}`,
  description: finding.detail,
  evidence:
    finding.probe === undefined
      ? { kind: 'catalog', schema: finding.schema }
      : { kind: 'probe', schema: finding.schema, ...finding.probe },
  remediation: finding.fixHint,
})

/** Actor ids stay out on purpose: they are real user ids, and the report may be shared. */
export function toReport(result: ScanResult): Report {
  return {
    version: REPORT_VERSION,
    scannedAt: result.startedAt,
    database: {
      host: result.target.host,
      name: result.target.database,
      schemas: result.target.schemas,
    },
    findings: [...result.findings].sort(compareFindings).map(toReportFinding),
    summary: {
      total: result.findings.filter((f) => f.severity !== 'info').length,
      bySeverity: result.counts,
      score: result.score,
      grade: result.grade,
      tablesScanned: result.tables.length,
      probesRun: result.probes.length,
      durationMs: result.durationMs,
      probes: result.probes,
      inconclusive: result.probes.filter((p) => p.outcome === 'inconclusive').length,
      warnings: result.warnings,
    },
  }
}
