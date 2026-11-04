import { describe, expect, it } from 'vitest'
import { bearerToken, safeEqual } from '../supabase/functions/_shared/auth'
import { ingestBody } from '../supabase/functions/_shared/report-schema'

describe('safeEqual', () => {
  it('accepts the exact secret only', () => {
    expect(safeEqual('secret', 'secret')).toBe(true)
    expect(safeEqual('secreT', 'secret')).toBe(false)
    expect(safeEqual('secret2', 'secret')).toBe(false)
    expect(safeEqual('secre', 'secret')).toBe(false)
    expect(safeEqual('', 'secret')).toBe(false)
  })

  it('never accepts anything when the secret is not configured', () => {
    expect(safeEqual('', '')).toBe(false)
  })
})

describe('bearerToken', () => {
  it('reads the token, and gives nothing for any other header', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('Basic abc')).toBe('')
    expect(bearerToken(null)).toBe('')
  })
})

const probe = { schema: 'public', table: 't', actor: 'anon', action: 'select_all', outcome: 'denied', rowCount: null }
const finding = {
  id: 'RR001',
  severity: 'critical',
  table: 't',
  policy: null,
  probe: null,
  description: 'd',
  evidence: { kind: 'catalog', schema: 'public' },
  remediation: 'r',
}
const body = {
  project: 'CareNote demo',
  report: {
    version: 1,
    scannedAt: '2026-11-04T00:00:00.000Z',
    database: { host: 'h', name: 'postgres', schemas: ['public'] },
    findings: [finding],
    summary: {
      total: 1,
      bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      score: 75,
      grade: 'D',
      tablesScanned: 1,
      probesRun: 1,
      durationMs: 10,
      probes: [probe],
      inconclusive: 0,
      warnings: [],
    },
  },
}
const withSummary = (overrides: Record<string, unknown>): unknown => ({
  ...body,
  report: { ...body.report, summary: { ...body.report.summary, ...overrides } },
})

describe('ingestBody', () => {
  it('accepts a real report', () => {
    expect(ingestBody.safeParse(body).success).toBe(true)
  })

  it.each([
    ['no project', { ...body, project: '' }],
    ['a long project name', { ...body, project: 'x'.repeat(81) }],
    ['another report version', { ...body, report: { ...body.report, version: 2 } }],
    ['a made-up rule id', { ...body, report: { ...body.report, findings: [{ ...finding, id: 'drop table' }] } }],
    ['a huge description', { ...body, report: { ...body.report, findings: [{ ...finding, description: 'x'.repeat(9000) }] } }],
    ['too many findings', { ...body, report: { ...body.report, findings: Array.from({ length: 2001 }, () => finding) } }],
    ['a score over 100', withSummary({ score: 101 })],
    ['a made-up grade', withSummary({ grade: 'Z' })],
    ['a made-up actor', withSummary({ probes: [{ ...probe, actor: 'root' }] })],
    ['a negative row count', withSummary({ probes: [{ ...probe, rowCount: -1 }] })],
  ])('rejects %s', (_label, candidate) => {
    expect(ingestBody.safeParse(candidate).success).toBe(false)
  })
})
