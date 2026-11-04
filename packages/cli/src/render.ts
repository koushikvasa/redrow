import { SEVERITIES, type ProbeResult, type Report, type ReportFinding, type Severity } from '@redrow/engine'
import pc from 'picocolors'
import type { Colors } from 'picocolors/types'
import { sanitizeForTerminal as clean } from './sanitize'

/** The words to use for the attackers. Absent, a report says anon and user_a. */
export interface RenderPersona {
  readonly anon: string
  readonly anonShort: string
  readonly loggedIn: string
  readonly userA: string
  readonly others: string
}

export interface RenderOptions {
  readonly color: boolean
  readonly verbose: boolean
  readonly persona?: RenderPersona
}

const MATRIX_COLUMNS = [
  { actor: 'anon', action: 'select_all', label: 'anon read', short: 'read', group: 'anon' },
  { actor: 'anon', action: 'update_any', label: 'anon upd', short: 'upd', group: 'anon' },
  { actor: 'anon', action: 'delete_any', label: 'anon del', short: 'del', group: 'anon' },
  { actor: 'anon', action: 'insert_other', label: 'anon ins', short: 'ins', group: 'anon' },
  { actor: 'user_a', action: 'select_own', label: 'A own', short: 'own', group: 'own' },
  { actor: 'user_a', action: 'select_others', label: 'A others', short: 'read', group: 'others' },
  { actor: 'user_a', action: 'select_all', label: 'A all', short: 'all', group: 'others' },
  { actor: 'user_a', action: 'update_other', label: 'A upd', short: 'upd', group: 'others' },
  { actor: 'user_a', action: 'delete_other', label: 'A del', short: 'del', group: 'others' },
  { actor: 'user_a', action: 'insert_other', label: 'A ins', short: 'ins', group: 'others' },
] as const

type MatrixColumn = (typeof MATRIX_COLUMNS)[number]

const possessive = (noun: string): string => (noun.endsWith('s') ? `${noun}'` : `${noun}'s`)

/** "Dr. Ana → read other doctors' rows". The table is already on the line above. */
function probeInWords(actor: string, action: string, persona: RenderPersona): string {
  if (actor === 'anon') {
    const verbs: Readonly<Record<string, string>> = { select_all: 'read', update_any: 'change', delete_any: 'delete', insert_other: 'add' }
    return `${persona.anonShort} → ${verbs[action] ?? action} rows`
  }
  if (action === 'select_own') return `${persona.userA} → read own rows`
  if (action === 'insert_other') return `${persona.userA} → add rows as ${persona.others}`
  const verbs: Readonly<Record<string, string>> = { select_others: 'read', select_all: 'read', update_other: 'change', delete_other: 'delete' }
  return `${persona.userA} → ${verbs[action] ?? action} ${possessive(persona.others)} rows`
}

/** The engine's sentences, in the persona's words. Only the words a report's reader sees change. */
const impactInWords = (text: string, persona: RenderPersona): string =>
  text
    .replaceAll('Anyone holding the public anon key', persona.anon)
    .replaceAll('anyone holding the public anon key', `${persona.anon.charAt(0).toLowerCase()}${persona.anon.slice(1)}`)
    .replaceAll('Every signed-in user', persona.loggedIn)
    .replaceAll('A signed-in user', persona.userA)
    .replaceAll('owned by other users', `owned by ${persona.others}`)
    .replaceAll('owned by someone else', `owned by ${persona.others}`)

const severityColor = (colors: Colors, severity: Severity): ((text: string) => string) =>
  ({
    critical: (text: string) => colors.bold(colors.red(text)),
    high: colors.red,
    medium: colors.yellow,
    low: colors.dim,
    info: colors.cyan,
  })[severity]

const groupLabel = (severity: Severity): string =>
  severity === 'info' ? 'DECLARED EXPOSURE' : severity.toUpperCase()

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const formatProbe = (finding: ReportFinding, persona: RenderPersona | undefined): string => {
  if (finding.probe === null || finding.evidence.kind !== 'probe') return 'catalog check'
  const { actor, action, outcome, rowCount } = finding.evidence
  const who = persona === undefined ? clean(finding.probe) : probeInWords(actor, action, persona)
  return `${who} (${outcome}${rowCount === null ? '' : `, ${plural(rowCount, 'row')}`})`
}

function renderFinding(finding: ReportFinding, colors: Colors, persona: RenderPersona | undefined): string[] {
  const target =
    finding.table === null ? clean(finding.evidence.schema) : `${clean(finding.evidence.schema)}.${clean(finding.table)}`
  return [
    `  ${colors.bold(finding.id)}  ${target}`,
    `    Policy:  ${finding.policy === null ? '-' : clean(finding.policy)}`,
    `    Probe:   ${formatProbe(finding, persona)}`,
    `    Impact:  ${persona === undefined ? clean(finding.description) : impactInWords(clean(finding.description), persona)}`,
    `    Fix:     ${clean(finding.remediation)}`,
    '',
  ]
}

function renderFindings(report: Report, colors: Colors, persona: RenderPersona | undefined): string[] {
  if (report.findings.length === 0) return [colors.green('No findings.'), '']
  return SEVERITIES.flatMap((severity) => {
    const group = report.findings.filter((f) => f.severity === severity)
    if (group.length === 0) return []
    return [
      severityColor(colors, severity)(`${groupLabel(severity)} (${group.length})`),
      '',
      ...group.flatMap((f) => renderFinding(f, colors, persona)),
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

/** Widens the last column of a group until the group's name fits above it. */
function fitGroupLabels(columns: readonly MatrixColumn[], widths: number[], labels: Readonly<Record<MatrixColumn['group'], string>>): void {
  for (const group of ['anon', 'own', 'others'] as const) {
    const members = columns.flatMap((c, i) => (c.group === group ? [i] : []))
    const last = members.at(-1)
    if (last === undefined) continue
    const total = members.reduce((sum, i) => sum + (widths[i] as number), 0) + 2 * (members.length - 1)
    widths[last] = (widths[last] as number) + Math.max(0, labels[group].length - total)
  }
}

/** The row above the column labels: each attacker's name, over their columns. */
function groupHeader(columns: readonly MatrixColumn[], widths: readonly number[], labels: Readonly<Record<MatrixColumn['group'], string>>, nameWidth: number): string {
  const cells = (['anon', 'own', 'others'] as const).flatMap((group) => {
    const members = columns.flatMap((c, i) => (c.group === group ? [i] : []))
    if (members.length === 0) return []
    const total = members.reduce((sum, i) => sum + (widths[i] as number), 0) + 2 * (members.length - 1)
    return [labels[group].padEnd(total)]
  })
  return ['' .padEnd(nameWidth), ...cells].join('  ').trimEnd()
}

function renderMatrix(probes: readonly ProbeResult[], colors: Colors, persona: RenderPersona | undefined): string[] {
  if (probes.length === 0) return []
  const tables = [...new Set(probes.map((p) => `${clean(p.schema)}.${clean(p.table)}`))]
  const columns = MATRIX_COLUMNS.filter((c) => probes.some((p) => p.actor === c.actor && p.action === c.action))
  const probeAt = (name: string, column: MatrixColumn): ProbeResult | undefined =>
    probes.find(
      (p) =>
        `${clean(p.schema)}.${clean(p.table)}` === name && p.actor === column.actor && p.action === column.action,
    )
  const nameWidth = Math.max('table'.length, ...tables.map((t) => t.length))
  const labelOf = (c: MatrixColumn): string => (persona === undefined ? c.label : c.short)
  const widths = columns.map((c) =>
    Math.max(labelOf(c).length, ...tables.map((t) => cellText(probeAt(t, c)).length)),
  )
  const groupLabels =
    persona === undefined
      ? undefined
      : { anon: persona.anonShort, own: persona.userA, others: `${persona.userA} → ${persona.others}` }
  if (groupLabels !== undefined) fitGroupLabels(columns, widths, groupLabels)
  const header = [
    'table'.padEnd(nameWidth),
    ...columns.map((c, i) => labelOf(c).padEnd(widths[i] as number)),
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
    ...(groupLabels === undefined ? [] : [colors.bold(groupHeader(columns, widths, groupLabels, nameWidth))]),
    colors.dim(header.trimEnd()),
    ...rows,
    '',
  ]
}

function renderProbeList(probes: readonly ProbeResult[], colors: Colors, persona: RenderPersona | undefined): string[] {
  if (probes.length === 0) return []
  return [
    colors.bold('Probes'),
    '',
    ...probes.map(
      (p) =>
        `  ${clean(p.schema)}.${clean(p.table)}  ${persona === undefined ? `${p.actor}:${p.action}` : probeInWords(p.actor, p.action, persona)}  ${p.outcome}` +
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
  const counts = SEVERITIES.filter((s) => s !== 'info')
    .map((s) => `${summary.bySeverity[s]} ${s}`)
    .join(', ')
  const declared = summary.bySeverity.info
  const scoreText = `Score ${summary.score}/100, grade ${summary.grade}`
  const passed = summary.total === 0
  return [
    passed ? colors.green(colors.bold(scoreText)) : colors.red(colors.bold(scoreText)),
    `${plural(summary.total, 'finding')}: ${counts}` +
      `${declared === 0 ? '' : `, plus ${plural(declared, 'declared exposure')}`}. ` +
      `${plural(summary.tablesScanned, 'table')}, ${plural(summary.probesRun, 'probe')}` +
      `${summary.inconclusive === 0 ? '' : ` (${summary.inconclusive} inconclusive)`}, ` +
      `${(summary.durationMs / 1000).toFixed(1)}s.`,
  ]
}

/** A config file is input too, so its words get the same treatment as names from a database. */
const cleanPersona = (persona: RenderPersona): RenderPersona => ({
  anon: clean(persona.anon),
  anonShort: clean(persona.anonShort),
  loggedIn: clean(persona.loggedIn),
  userA: clean(persona.userA),
  others: clean(persona.others),
})

/** The terminal report, as text. Every name from the scanned database is sanitized on the way through. */
export function renderReport(report: Report, options: RenderOptions): string {
  const colors = pc.createColors(options.color)
  const { host, name, schemas } = report.database
  const persona = options.persona === undefined ? undefined : cleanPersona(options.persona)
  const lines = [
    colors.bold(`Red Row report: ${clean(host)}/${clean(name)} (${schemas.map(clean).join(', ')})`),
    '',
    ...renderFindings(report, colors, persona),
    ...renderMatrix(report.summary.probes, colors, persona),
    ...(options.verbose ? renderProbeList(report.summary.probes, colors, persona) : []),
    ...renderWarnings(report, colors),
    ...renderSummary(report, colors),
  ]
  return `${lines.join('\n')}\n`
}

export const isColorSupported: boolean = pc.isColorSupported
