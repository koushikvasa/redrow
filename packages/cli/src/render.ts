import { SEVERITIES, type ProbeResult, type Report, type ReportFinding, type Severity } from '@redrow/engine'
import pc from 'picocolors'
import type { Colors } from 'picocolors/types'
import { sanitizeForTerminal as clean } from './sanitize'

export interface RenderOptions {
  readonly color: boolean
  readonly verbose: boolean
}

const MATRIX_COLUMNS = [
  { actor: 'anon', action: 'select_all', label: 'anon read' },
  { actor: 'anon', action: 'update_any', label: 'anon upd' },
  { actor: 'anon', action: 'delete_any', label: 'anon del' },
  { actor: 'anon', action: 'insert_other', label: 'anon ins' },
  { actor: 'user_a', action: 'select_own', label: 'A own' },
  { actor: 'user_a', action: 'select_others', label: 'A others' },
  { actor: 'user_a', action: 'select_all', label: 'A all' },
  { actor: 'user_a', action: 'update_other', label: 'A upd' },
  { actor: 'user_a', action: 'delete_other', label: 'A del' },
  { actor: 'user_a', action: 'insert_other', label: 'A ins' },
] as const

type MatrixColumn = (typeof MATRIX_COLUMNS)[number]

const severityColor = (colors: Colors, severity: Severity): ((text: string) => string) =>
  ({
    critical: (text: string) => colors.bold(colors.red(text)),
    high: colors.red,
    medium: colors.yellow,
    low: colors.dim,
  })[severity]

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const formatProbe = (finding: ReportFinding): string => {
  if (finding.probe === null || finding.evidence.kind !== 'probe') return 'catalog check'
  const { outcome, rowCount } = finding.evidence
  return `${clean(finding.probe)} (${outcome}${rowCount === null ? '' : `, ${plural(rowCount, 'row')}`})`
}

function renderFinding(finding: ReportFinding, colors: Colors): string[] {
  const target =
    finding.table === null ? clean(finding.evidence.schema) : `${clean(finding.evidence.schema)}.${clean(finding.table)}`
  return [
    `  ${colors.bold(finding.id)}  ${target}`,
    `    Policy:  ${finding.policy === null ? '-' : clean(finding.policy)}`,
    `    Probe:   ${formatProbe(finding)}`,
    `    Impact:  ${clean(finding.description)}`,
    `    Fix:     ${clean(finding.remediation)}`,
    '',
  ]
}

function renderFindings(report: Report, colors: Colors): string[] {
  if (report.findings.length === 0) return [colors.green('No findings.'), '']
  return SEVERITIES.flatMap((severity) => {
    const group = report.findings.filter((f) => f.severity === severity)
    if (group.length === 0) return []
    return [
      severityColor(colors, severity)(`${severity.toUpperCase()} (${group.length})`),
      '',
      ...group.flatMap((f) => renderFinding(f, colors)),
    ]
  })
}

const cellText = (probe: ProbeResult | undefined): string => {
  if (probe === undefined) return ' '
  if (probe.outcome === 'allowed') return probe.rowCount === null ? '✔' : `✔ ${probe.rowCount}`
  if (probe.outcome === 'denied') return '✖'
  return probe.outcome === 'inconclusive' ? '?' : '-'
}

const colorCell = (colors: Colors, probe: ProbeResult | undefined, text: string): string => {
  if (probe === undefined) return text
  if (probe.outcome === 'denied') return colors.green(text)
  if (probe.outcome !== 'allowed') return colors.dim(text)
  // Seeing your own rows is the point of the app, so it isn't a leak.
  return probe.action === 'select_own' ? colors.green(text) : colors.red(text)
}

function renderMatrix(probes: readonly ProbeResult[], colors: Colors): string[] {
  if (probes.length === 0) return []
  const tables = [...new Set(probes.map((p) => `${clean(p.schema)}.${clean(p.table)}`))]
  const columns = MATRIX_COLUMNS.filter((c) => probes.some((p) => p.actor === c.actor && p.action === c.action))
  const probeAt = (name: string, column: MatrixColumn): ProbeResult | undefined =>
    probes.find(
      (p) =>
        `${clean(p.schema)}.${clean(p.table)}` === name && p.actor === column.actor && p.action === column.action,
    )
  const nameWidth = Math.max('table'.length, ...tables.map((t) => t.length))
  const widths = columns.map((c) =>
    Math.max(c.label.length, ...tables.map((t) => cellText(probeAt(t, c)).length)),
  )
  const header = [
    'table'.padEnd(nameWidth),
    ...columns.map((c, i) => c.label.padEnd(widths[i] as number)),
  ].join('  ')
  const rows = tables.map((name) =>
    [
      name.padEnd(nameWidth),
      ...columns.map((c, i) => {
        const probe = probeAt(name, c)
        return colorCell(colors, probe, cellText(probe).padEnd(widths[i] as number))
      }),
    ]
      .join('  ')
      .trimEnd(),
  )
  return [
    colors.bold('Leak matrix'),
    colors.dim('✔ allowed (with rows)   ✖ denied   ? inconclusive   - not applicable'),
    '',
    colors.dim(header.trimEnd()),
    ...rows,
    '',
  ]
}

function renderProbeList(probes: readonly ProbeResult[], colors: Colors): string[] {
  if (probes.length === 0) return []
  return [
    colors.bold('Probes'),
    '',
    ...probes.map(
      (p) =>
        `  ${clean(p.schema)}.${clean(p.table)}  ${p.actor}:${p.action}  ${p.outcome}` +
        `${p.rowCount === null ? '' : `  ${plural(p.rowCount, 'row')}`}`,
    ),
    '',
  ]
}

function renderWarnings(report: Report, colors: Colors): string[] {
  const { inconclusive, warnings } = report.summary
  const lines = [
    ...warnings.map(clean),
    ...(inconclusive === 0
      ? []
      : [`${plural(inconclusive, 'probe')} proved nothing either way (? in the matrix), so "no findings" doesn't cover them.`]),
  ]
  return lines.length === 0 ? [] : [...lines.map((line) => colors.yellow(`Warning: ${line}`)), '']
}

function renderSummary(report: Report, colors: Colors): string[] {
  const { summary } = report
  const counts = SEVERITIES.map((s) => `${summary.bySeverity[s]} ${s}`).join(', ')
  const scoreText = `Score ${summary.score}/100, grade ${summary.grade}`
  const passed = summary.total === 0
  return [
    passed ? colors.green(colors.bold(scoreText)) : colors.red(colors.bold(scoreText)),
    `${plural(summary.total, 'finding')}: ${counts}. ` +
      `${plural(summary.tablesScanned, 'table')}, ${plural(summary.probesRun, 'probe')}` +
      `${summary.inconclusive === 0 ? '' : ` (${summary.inconclusive} inconclusive)`}, ` +
      `${(summary.durationMs / 1000).toFixed(1)}s.`,
  ]
}

/** The terminal report, as text. Every name from the scanned database is sanitized on the way through. */
export function renderReport(report: Report, options: RenderOptions): string {
  const colors = pc.createColors(options.color)
  const { host, name, schemas } = report.database
  const lines = [
    colors.bold(`Red Row report: ${clean(host)}/${clean(name)} (${schemas.map(clean).join(', ')})`),
    '',
    ...renderFindings(report, colors),
    ...renderMatrix(report.summary.probes, colors),
    ...(options.verbose ? renderProbeList(report.summary.probes, colors) : []),
    ...renderWarnings(report, colors),
    ...renderSummary(report, colors),
  ]
  return `${lines.join('\n')}\n`
}

export const isColorSupported: boolean = pc.isColorSupported
