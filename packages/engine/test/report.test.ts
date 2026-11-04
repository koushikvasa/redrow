import { describe, expect, it } from 'vitest'
import { makeFinding } from '../src/rules'
import { REPORT_VERSION, toReport } from '../src/report'
import type { ScanResult } from '../src/types'

const base: ScanResult = {
  engineVersion: '0.1.0',
  startedAt: '2026-11-04T12:00:00.000Z',
  durationMs: 1234,
  target: { host: 'db.example.com', database: 'app_test', schemas: ['public'] },
  score: 40,
  grade: 'D',
  counts: { critical: 1, high: 1, medium: 0, low: 1 },
  tables: [{ schema: 'public', table: 't', rlsEnabled: true, totalRows: 5, sensitive: [] }],
  findings: [],
  probes: [
    { schema: 'public', table: 't', actor: 'anon', action: 'select_all', outcome: 'denied', rowCount: 0 },
  ],
  actors: { userA: 'a', userB: 'b' },
  warnings: [],
}

const lowStatic = makeFinding('RR008', { schema: 'public', table: 't', policy: 'p' }, 'slow')
const highStatic = makeFinding('RR007', { schema: 'app', functionName: 'f', functionArgs: '' }, 'callable')
const criticalProbe = {
  ...makeFinding('RR102', { schema: 'public', table: 't', column: 'user_id' }, 'A read 5 rows.'),
  rowsExposed: 5,
  probe: { actor: 'user_a', action: 'select_others', outcome: 'allowed', rowCount: 5 },
} as const

describe('toReport', () => {
  const report = toReport({ ...base, findings: [lowStatic, highStatic, criticalProbe] })

  it('has exactly the agreed top-level shape', () => {
    expect(Object.keys(report).sort()).toEqual(['database', 'findings', 'scannedAt', 'summary', 'version'])
    expect(report.version).toBe(REPORT_VERSION)
    expect(report.scannedAt).toBe(base.startedAt)
    expect(report.database).toEqual({ host: 'db.example.com', name: 'app_test', schemas: ['public'] })
  })

  it('gives every finding exactly the agreed fields', () => {
    for (const finding of report.findings) {
      expect(Object.keys(finding).sort()).toEqual([
        'description',
        'evidence',
        'id',
        'policy',
        'probe',
        'remediation',
        'severity',
        'table',
      ])
    }
  })

  it('sorts findings most severe first', () => {
    expect(report.findings.map((f) => f.severity)).toEqual(['critical', 'high', 'low'])
  })

  it('sorts within a severity by rule id, then table, so output is stable between runs', () => {
    const a = makeFinding('RR008', { schema: 'public', table: 'b', policy: 'p' }, 'x')
    const b = makeFinding('RR008', { schema: 'public', table: 'a', policy: 'p' }, 'x')
    const c = makeFinding('RR009', { schema: 'public', table: 'a' }, 'x')
    const sorted = toReport({ ...base, findings: [c, a, b] }).findings
    expect(sorted.map((f) => `${f.id}:${f.table}`)).toEqual(['RR008:a', 'RR008:b', 'RR009:a'])
  })

  it('maps a probe finding with its evidence', () => {
    expect(report.findings[0]).toEqual({
      id: 'RR102',
      severity: 'critical',
      table: 't',
      policy: null,
      probe: 'user_a:select_others',
      description: 'A read 5 rows.',
      evidence: {
        kind: 'probe',
        schema: 'public',
        actor: 'user_a',
        action: 'select_others',
        outcome: 'allowed',
        rowCount: 5,
      },
      remediation: criticalProbe.fixHint,
    })
  })

  it('maps a catalog finding with nulls rather than missing keys', () => {
    expect(report.findings[1]).toMatchObject({
      id: 'RR007',
      table: null,
      policy: null,
      probe: null,
      evidence: { kind: 'catalog', schema: 'app' },
    })
    expect(report.findings[2]?.policy).toBe('p')
  })

  it('summarizes counts, score and the probe matrix H6 needs', () => {
    expect(report.summary).toEqual({
      total: 3,
      bySeverity: { critical: 1, high: 1, medium: 0, low: 1 },
      score: 40,
      grade: 'D',
      tablesScanned: 1,
      probesRun: 1,
      durationMs: 1234,
      probes: base.probes,
      inconclusive: 0,
      warnings: [],
    })
  })

  it('counts inconclusive probes and carries warnings, so a clean report can be qualified', () => {
    const { summary } = toReport({
      ...base,
      warnings: ['careful'],
      probes: [
        ...base.probes,
        { schema: 'public', table: 't', actor: 'anon', action: 'delete_any', outcome: 'inconclusive', rowCount: null },
      ],
    })
    expect(summary.inconclusive).toBe(1)
    expect(summary.warnings).toEqual(['careful'])
  })

  it('contains no actor ids, which are real user ids', () => {
    expect(JSON.stringify(toReport(base))).not.toContain('"userA"')
  })
})
