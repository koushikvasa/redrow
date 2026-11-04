import { describe, expect, it } from 'vitest'
import type { Report } from '../src/report'
import { toScanRows } from '../src/rows'

const PROJECT = '00000000-0000-4000-8000-000000000001'

const REPORT: Report = {
  version: 1,
  scannedAt: '2026-11-04T12:00:00.000Z',
  database: { host: 'h', name: 'postgres', schemas: ['public'] },
  findings: [
    {
      id: 'RR102',
      severity: 'critical',
      table: 'patients',
      policy: 'open',
      probe: 'user_a:select_others',
      description: 'A signed-in user can read 80 rows.',
      evidence: { kind: 'probe', schema: 'public', actor: 'user_a', action: 'select_others', outcome: 'allowed', rowCount: 80 },
      remediation: 'create policy ...',
    },
    {
      id: 'RR007',
      severity: 'high',
      table: null,
      policy: null,
      probe: null,
      description: 'public.f(q text) is SECURITY DEFINER.',
      evidence: { kind: 'catalog', schema: 'public' },
      remediation: 'revoke ...',
    },
    {
      id: 'RR999',
      severity: 'info',
      table: 'projects',
      policy: null,
      probe: null,
      description: 'Declared.',
      evidence: { kind: 'catalog', schema: 'public' },
      remediation: 'none',
    },
  ],
  summary: {
    total: 2,
    bySeverity: { critical: 1, high: 1, medium: 0, low: 0, info: 1 },
    score: 40,
    grade: 'D',
    tablesScanned: 2,
    probesRun: 1,
    durationMs: 1234,
    probes: [{ schema: 'public', table: 'patients', actor: 'user_a', action: 'select_others', outcome: 'allowed', rowCount: 80 }],
    inconclusive: 0,
    warnings: [],
  },
}

describe('toScanRows', () => {
  const rows = toScanRows(REPORT, PROJECT, 'sweep')

  it('maps the summary to one scan_runs row', () => {
    expect(rows.run).toMatchObject({
      project_id: PROJECT,
      source: 'sweep',
      score: 40,
      grade: 'D',
      critical: 1,
      high: 1,
      medium: 0,
      low: 0,
      tables_scanned: 2,
      probes_run: 1,
      duration_ms: 1234,
    })
    expect(rows.run.engine_version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('maps findings, with the rule title and the row count from a probe', () => {
    expect(rows.findings[0]).toEqual({
      project_id: PROJECT,
      rule_id: 'RR102',
      severity: 'critical',
      schema_name: 'public',
      table_name: 'patients',
      title: expect.any(String),
      detail: 'A signed-in user can read 80 rows.',
      rows_exposed: 80,
      fix_hint: 'create policy ...',
    })
    expect(rows.findings[0]?.title.length).toBeGreaterThan(3)
  })

  it('leaves the row count null for a catalog finding', () => {
    expect(rows.findings[1]?.rows_exposed).toBeNull()
    expect(rows.findings[1]?.table_name).toBeNull()
  })

  it('falls back to the rule id for a rule it does not know', () => {
    expect(rows.findings[2]?.title).toBe('RR999')
  })

  it('maps probes to matrix cells, counts only', () => {
    expect(rows.probes).toEqual([
      { project_id: PROJECT, table_name: 'patients', actor: 'user_a', action: 'select_others', outcome: 'allowed', row_count: 80 },
    ])
  })
})
