import { describe, expect, it } from 'vitest'
import { COLUMNS, buildMatrix } from '../lib/matrix'
import { agoText, bandFor, chartPoints, splitBySeeded } from '../lib/series'
import type { FindingRow, HourlyScore, ProbeRow, RecentScore } from '../lib/types'

const probe = (overrides: Partial<ProbeRow>): ProbeRow => ({
  table_name: 't',
  actor: 'anon',
  action: 'select_all',
  outcome: 'denied',
  row_count: null,
  ...overrides,
})

const cell = (rows: ReturnType<typeof buildMatrix>, table: string, column: string) =>
  rows.find((r) => r.table === table)?.cells.find((c) => c.column === column)

const finding = (rule_id: string, severity = 'high', table_name = 't') => ({ rule_id, severity, table_name }) as FindingRow

describe('buildMatrix', () => {
  it('gives every table one cell per column, sorted by table', () => {
    const rows = buildMatrix([probe({ table_name: 'b' }), probe({ table_name: 'a' })], [])
    expect(rows.map((r) => r.table)).toEqual(['a', 'b'])
    expect(rows[0]?.cells).toHaveLength(COLUMNS.length)
  })

  it('marks an allowed anon read as a leak with its count', () => {
    const rows = buildMatrix([probe({ outcome: 'allowed', row_count: 3 })], [finding('RR101')])
    expect(cell(rows, 't', 'anon-read')).toMatchObject({ state: 'leak', count: 3 })
  })

  // A 100/A page must not show red: reading a board that's meant to be public isn't a leak.
  it('does not call an allowed cell a leak unless a finding backs it', () => {
    const rows = buildMatrix([probe({ outcome: 'allowed', row_count: 30 })], [])
    expect(cell(rows, 't', 'anon-read')).toMatchObject({ state: 'open', count: 30, heat: 0 })
  })

  it('needs the finding to be about that cell, on that table, and counted', () => {
    const allowed = [probe({ outcome: 'allowed', row_count: 3 })]
    expect(cell(buildMatrix(allowed, [finding('RR104')]), 't', 'anon-read')?.state).toBe('open')
    expect(cell(buildMatrix(allowed, [finding('RR101', 'high', 'other')]), 't', 'anon-read')?.state).toBe('open')
    const others = [probe({ actor: 'user_a', action: 'select_others', outcome: 'allowed', row_count: 3 })]
    expect(cell(buildMatrix(others, [finding('RR102', 'info')]), 't', 'others-read')?.state).toBe('open')
  })

  it.each([
    ['RR001', 'anon', 'select_all', 'anon-read'],
    ['RR106', 'anon', 'update_any', 'anon-update'],
    ['RR002', 'anon', 'delete_any', 'anon-delete'],
    ['RR003', 'user_a', 'select_all', 'others-read'],
    ['RR103', 'user_a', 'update_other', 'others-update'],
    ['RR104', 'user_a', 'delete_other', 'others-delete'],
    ['RR105', 'user_a', 'insert_other', 'others-insert'],
  ])('%s backs a leak for %s %s', (id, actor, action, column) => {
    const rows = buildMatrix([probe({ actor, action, outcome: 'allowed', row_count: 2 })], [finding(id)])
    expect(cell(rows, 't', column)?.state).toBe('leak')
  })

  it('does not call reading your own rows a leak', () => {
    const rows = buildMatrix([probe({ actor: 'user_a', action: 'select_own', outcome: 'allowed', row_count: 40 })], [])
    expect(cell(rows, 't', 'own-read')).toMatchObject({ state: 'own', count: 40 })
  })

  it('shows select_all by a signed-in user as reading other users', () => {
    const rows = buildMatrix([probe({ actor: 'user_a', action: 'select_all', outcome: 'allowed', row_count: 9 })], [finding('RR102')])
    expect(cell(rows, 't', 'others-read')?.state).toBe('leak')
  })

  it('marks a declared anon read as declared, not as a leak', () => {
    const declared = { severity: 'info', rule_id: 'RR101', table_name: 't' } as FindingRow
    const rows = buildMatrix([probe({ outcome: 'allowed', row_count: 2 })], [declared])
    expect(cell(rows, 't', 'anon-read')?.state).toBe('declared')
  })

  it.each(['inconclusive', 'not_applicable'])('treats %s as proving nothing', (outcome) => {
    expect(cell(buildMatrix([probe({ outcome })], []), 't', 'anon-read')?.state).toBe('na')
  })

  it('treats a probe that never ran as proving nothing', () => {
    expect(cell(buildMatrix([probe({})], []), 't', 'others-delete')?.state).toBe('na')
  })

  it('scales heat by row count, biggest first', () => {
    const rows = buildMatrix(
      [
        probe({ outcome: 'allowed', row_count: 240 }),
        probe({ actor: 'user_a', action: 'select_others', outcome: 'allowed', row_count: 2 }),
      ],
      [finding('RR101'), finding('RR102')],
    )
    const big = cell(rows, 't', 'anon-read')?.heat as number
    const small = cell(rows, 't', 'others-read')?.heat as number
    expect(big).toBe(1)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(big)
  })
})

describe('chartPoints', () => {
  const NOW = Date.parse('2026-11-04T12:30:00Z')
  const DAY = 86_400_000
  const hourly = (hour: string, score: number, seeded = false): HourlyScore => ({ hour, score, seeded })
  const recent = (created_at: string, score: number, source = 'sweep'): RecentScore => ({ created_at, score, source })

  it('uses hourly averages until the exact scans start, then every scan in order', () => {
    const points = chartPoints(
      [hourly('2026-11-04T08:00:00Z', 5), hourly('2026-11-04T11:00:00Z', 7)],
      [recent('2026-11-04T12:20:00Z', 100), recent('2026-11-04T11:30:00Z', 0)],
      NOW,
      DAY,
    )
    expect(points.map((p) => p.score)).toEqual([5, 0, 100])
  })

  it('leaves out anything before the window', () => {
    const points = chartPoints([hourly('2026-11-01T08:00:00Z', 5)], [], NOW, DAY)
    expect(points).toEqual([])
  })

  it('carries the seeded flag through from both sources', () => {
    const points = chartPoints(
      [hourly('2026-11-04T08:00:00Z', 5, true)],
      [recent('2026-11-04T12:00:00Z', 7, 'seed'), recent('2026-11-04T12:10:00Z', 9)],
      NOW,
      DAY,
    )
    expect(points.map((p) => p.seeded)).toEqual([true, true, false])
  })
})

describe('splitBySeeded', () => {
  const point = (t: number, seeded: boolean) => ({ t, score: 1, seeded })

  it('splits where seeded history turns real, and joins the two runs', () => {
    const runs = splitBySeeded([point(1, true), point(2, true), point(3, false), point(4, false)])
    expect(runs.map((r) => r.map((p) => p.t))).toEqual([[1, 2], [2, 3, 4]])
    expect(runs[1]?.every((p) => !p.seeded)).toBe(true)
  })

  it('keeps one run when nothing changes, and nothing for no points', () => {
    expect(splitBySeeded([point(1, false), point(2, false)])).toHaveLength(1)
    expect(splitBySeeded([])).toEqual([])
  })
})

describe('agoText', () => {
  it.each([
    [0, '0s ago'],
    [12_400, '12s ago'],
    [120_000, '2m ago'],
    [7_200_000, '2h ago'],
    [-5000, '0s ago'],
  ])('%i ms is %s', (ms, text) => {
    expect(agoText(ms)).toBe(text)
  })
})

describe('bandFor', () => {
  it.each([
    [100, 'good'],
    [90, 'good'],
    [75, 'mid'],
    [59, 'bad'],
    [0, 'bad'],
  ])('%i is %s', (score, band) => {
    expect(bandFor(score)).toBe(band)
  })
})
