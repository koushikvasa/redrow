import { SEVERITIES, type ProbeResult, type Report, type ReportFinding, type Severity } from '@redrow/engine'
import { sanitizeForTerminal } from '../sanitize'
import { REPORT_CSS, REPORT_JS } from './html-assets'

/** `open` means the probe got through but no finding says that's a problem, such as a public board. */
export type CellState = 'leak' | 'open' | 'denied' | 'own' | 'declared' | 'na'

export interface MatrixCell {
  readonly column: string
  readonly state: CellState
  readonly count: number | null
  /** 0 to 1: how this leak's row count compares with the biggest on the page. */
  readonly intensity: number
}

export interface MatrixRow {
  readonly table: string
  readonly cells: readonly MatrixCell[]
}

/** `rules`: the findings that make an allowed cell a leak. RLS being off (RR001, RR002) backs every cell. */
const COLUMNS = [
  { id: 'anon-read', group: 'anon', label: 'read', rules: ['RR101'], probes: [['anon', 'select_all']] },
  { id: 'anon-insert', group: 'anon', label: 'insert', rules: ['RR106'], probes: [['anon', 'insert_other']] },
  { id: 'anon-update', group: 'anon', label: 'update', rules: ['RR106'], probes: [['anon', 'update_any']] },
  { id: 'anon-delete', group: 'anon', label: 'delete', rules: ['RR106'], probes: [['anon', 'delete_any']] },
  { id: 'own-read', group: 'own', label: 'read', rules: [], probes: [['user_a', 'select_own']] },
  { id: 'others-read', group: 'others', label: 'read', rules: ['RR102', 'RR003'], probes: [['user_a', 'select_others'], ['user_a', 'select_all']] },
  { id: 'others-insert', group: 'others', label: 'insert', rules: ['RR105'], probes: [['user_a', 'insert_other']] },
  { id: 'others-update', group: 'others', label: 'update', rules: ['RR103'], probes: [['user_a', 'update_other']] },
  { id: 'others-delete', group: 'others', label: 'delete', rules: ['RR104'], probes: [['user_a', 'delete_other']] },
] as const

const RLS_OFF_RULES: readonly string[] = ['RR001', 'RR002']

const GROUPS = [
  { id: 'anon', label: 'Anon', span: 4 },
  { id: 'own', label: 'User A, own', span: 1 },
  { id: 'others', label: 'User A → other users', span: 4 },
] as const

const SEVERITY_TITLES: Readonly<Record<Severity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  info: 'Declared exposure',
}

const DIAL_TICKS = 100
const DIAL_SWEEP_DEGREES = 270
const DIAL_START_DEGREES = -135

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Every name here comes from the scanned database, so all of it goes through this. */
const esc = (text: string): string =>
  sanitizeForTerminal(text).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] as string)

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const tableName = (p: { readonly schema: string; readonly table: string }): string => `${p.schema}.${p.table}`

function cellFor(
  column: (typeof COLUMNS)[number],
  probes: readonly ProbeResult[],
  isDeclared: boolean,
  biggestLeak: number,
  counted: ReadonlySet<string>,
): MatrixCell {
  const probe = probes.find((p) => column.probes.some(([actor, action]) => p.actor === actor && p.action === action))
  const base = { column: column.id, count: probe?.rowCount ?? null, intensity: 0 }
  if (probe === undefined || probe.outcome === 'inconclusive' || probe.outcome === 'not_applicable') {
    return { ...base, state: 'na' }
  }
  if (probe.outcome === 'denied') return { ...base, state: 'denied' }
  if (column.id === 'own-read') return { ...base, state: 'own' }
  if (column.id === 'anon-read' && isDeclared) return { ...base, state: 'declared' }
  const isBacked = [...column.rules, ...RLS_OFF_RULES].some((rule) => counted.has(rule))
  if (!isBacked) return { ...base, state: 'open' }
  const count = probe.rowCount ?? 1
  return { ...base, state: 'leak', intensity: Math.log(count + 1) / Math.log(biggestLeak + 1) }
}

/** The leak matrix as data: one row per table, one cell per column. */
export function matrixRows(report: Report): MatrixRow[] {
  const { probes } = report.summary
  const names = [...new Set(probes.map(tableName))]
  const declared = new Set(
    report.findings
      .filter((f) => f.severity === 'info' && f.id === 'RR101')
      .map((f) => `${f.evidence.schema}.${f.table}`),
  )
  const biggestLeak = Math.max(1, ...probes.filter((p) => p.outcome === 'allowed').map((p) => p.rowCount ?? 1))
  return names.map((name) => {
    const own = probes.filter((p) => tableName(p) === name)
    const counted = new Set(
      report.findings.filter((f) => f.severity !== 'info' && `${f.evidence.schema}.${f.table}` === name).map((f) => f.id),
    )
    return { table: name, cells: COLUMNS.map((c) => cellFor(c, own, declared.has(name), biggestLeak, counted)) }
  })
}

function cellText(cell: MatrixCell): string {
  switch (cell.state) {
    case 'leak':
    case 'open':
    case 'own':
    case 'declared':
      return cell.count === null ? '✔' : String(cell.count)
    case 'denied':
      return '✕'
    default:
      return '·'
  }
}

function renderMatrix(report: Report): string {
  const rows = matrixRows(report)
  if (rows.length === 0) return ''
  const hasState = (state: CellState): boolean => rows.some((r) => r.cells.some((c) => c.state === state))
  const hasDeclared = hasState('declared')
  const openKey = hasState('open') ? '<span><i class="key-open"></i>allowed, not a finding</span>' : ''
  let n = 0
  const body = rows
    .map((row) => {
      const cells = row.cells
        .map((cell) => {
          n += 1
          return `<td class="cell ${cell.state}" style="--heat:${cell.intensity.toFixed(3)};--n:${n}">${cellText(cell)}</td>`
        })
        .join('')
      return `<tr><th class="row" scope="row">${esc(row.table)}</th>${cells}</tr>`
    })
    .join('')
  return `<h2><span>Leak matrix</span><span class="legend">
<span><i class="key-leak"></i>leak, with rows</span><span><i class="key-own"></i>own rows, expected</span><span><i class="key-denied"></i>denied</span>
<span><i class="key-na"></i>n/a or inconclusive</span>${openKey}${hasDeclared ? '<span><i class="key-declared"></i>meant to be public</span>' : ''}</span></h2>
<div class="matrix-wrap"><table class="matrix"><thead>
<tr><th class="corner"></th>${GROUPS.map((g) => `<th class="group" colspan="${g.span}" scope="colgroup">${g.label}</th>`).join('')}</tr>
<tr><th></th>${COLUMNS.map((c) => `<th scope="col">${c.label}</th>`).join('')}</tr>
</thead><tbody>${body}</tbody></table></div>`
}

function renderDial(score: number, grade: string): string {
  const ticks = Array.from({ length: DIAL_TICKS }, (_, i) => {
    const angle = DIAL_START_DEGREES + (DIAL_SWEEP_DEGREES * i) / (DIAL_TICKS - 1)
    const lit = i < score
    return `<line class="${lit ? 'tick lit' : 'tick'}" style="--i:${i}" x1="190" y1="14" x2="190" y2="${i % 10 === 0 ? 44 : 36}" transform="rotate(${angle.toFixed(2)} 190 190)"></line>`
  }).join('')
  return `<div class="dial" role="img" aria-label="Score ${score} out of 100, grade ${esc(grade)}">
<svg viewBox="0 0 380 380" aria-hidden="true">${ticks}</svg>
<div class="readout"><div class="score-value" data-score="${score}">${score}</div><div class="score-max">/ 100</div><div class="grade">${esc(grade)}</div></div>
</div>`
}

function verdict(report: Report): string {
  const { total, score } = report.summary
  const declared = report.summary.bySeverity.info
  if (total === 0) {
    return declared === 0
      ? 'No leaks proven.'
      : `No leaks beyond <em>${plural(declared, 'declared exposure')}</em>.`
  }
  return score === 0 ? `<em>${plural(total, 'finding')}.</em> This database leaks.` : `<em>${plural(total, 'finding')}</em> to fix.`
}

function renderCounts(report: Report): string {
  const { bySeverity } = report.summary
  return (['critical', 'high', 'medium', 'low'] as const)
    .map((s) => `<div class="count ${s}${bySeverity[s] > 0 ? ' on' : ''}"><b>${bySeverity[s]}</b><span>${SEVERITY_TITLES[s]}</span></div>`)
    .join('')
}

function renderFinding(f: ReportFinding): string {
  const where = f.table === null ? f.evidence.schema : `${f.evidence.schema}.${f.table}`
  const proof =
    f.evidence.kind === 'probe'
      ? `proved by ${f.probe ?? ''}${f.evidence.rowCount === null ? '' : `, ${plural(f.evidence.rowCount, 'row')}`}`
      : 'found in the catalog'
  return `<article class="finding">
<div class="finding-head"><span class="rule">${esc(f.id)}</span><span class="where">${esc(where)}</span><span class="proof">${esc(proof)}</span></div>
<p class="impact">${esc(f.description)}</p>
${f.policy === null ? '' : `<p class="policy">Policy: ${esc(f.policy)}</p>`}
<div class="fix"><code>${esc(f.remediation)}</code><button type="button" class="copy">Copy</button></div>
</article>`
}

function renderFindings(report: Report): string {
  if (report.findings.length === 0) return '<p class="none">No findings.</p>'
  return SEVERITIES.map((severity) => {
    const group = report.findings.filter((f) => f.severity === severity)
    if (group.length === 0) return ''
    return `<section class="sev-${severity}"><div class="group-title">${SEVERITY_TITLES[severity]} <small>${group.length}</small></div>${group.map(renderFinding).join('')}</section>`
  }).join('')
}

function renderNotices(report: Report): string {
  const { inconclusive, warnings } = report.summary
  const lines = [
    ...warnings,
    ...(inconclusive === 0 ? [] : [`${plural(inconclusive, 'probe')} proved nothing either way, so "no findings" doesn't cover them.`]),
  ]
  return lines.map((line) => `<p class="notice">${esc(line)}</p>`).join('')
}

const bandFor = (score: number): string => (score >= 90 ? 'band-good' : score >= 60 ? 'band-mid' : 'band-bad')

/** One file with everything inline. The CSP makes the browser enforce "no external requests". */
export function renderHtmlReport(report: Report): string {
  const { summary, database } = report
  const target = `${database.host}/${database.name} (${database.schemas.join(', ')})`
  const stats = `${plural(summary.tablesScanned, 'table')}, ${plural(summary.probesRun, 'probe')}, ${(summary.durationMs / 1000).toFixed(1)}s`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Red Row: ${summary.score}/100 ${esc(summary.grade)}, ${esc(database.name)}</title>
<style>${REPORT_CSS}</style></head>
<body class="${bandFor(summary.score)}">
<header><div class="brand">RED<b>ROW</b></div><div class="target">${esc(target)}<br>${esc(report.scannedAt)}</div></header>
<div class="hero">${renderDial(summary.score, summary.grade)}
<div><h1 class="verdict">${verdict(report)}</h1><div class="counts">${renderCounts(report)}</div>
<p class="meta">${esc(stats)}</p>${renderNotices(report)}</div></div>
${renderMatrix(report)}
<h2><span>Findings</span></h2>
${renderFindings(report)}
<footer><span><strong>Nothing persists, and we only ever record counts.</strong> Every probe ran in a transaction that was rolled back.</span><span>Red Row</span></footer>
<script>${REPORT_JS}</script>
</body></html>
`
}
