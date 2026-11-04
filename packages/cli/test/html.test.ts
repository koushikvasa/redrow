import { describe, expect, it } from 'vitest'
import { matrixRows, renderHtmlReport } from '../src/report/html'
import { CRITICAL_ONLY_REPORT, DECLARED_ONLY_REPORT, EMPTY_REPORT, MIXED_REPORT } from './helpers'

const cellsOf = (html: string): number => (html.match(/class="cell /g) ?? []).length

describe('renderHtmlReport', () => {
  const html = renderHtmlReport(MIXED_REPORT)

  it('is a complete document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('</html>')
    expect(html).toContain('<title>')
  })

  it('makes no external requests at all', () => {
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/\bsrc=/)
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/@import|url\(/)
  })

  it('has the browser enforce that with a CSP', () => {
    expect(html).toMatch(/http-equiv="Content-Security-Policy"[^>]*default-src 'none'/)
  })

  it('shows the score, the grade and every severity count', () => {
    expect(html).toContain('data-score="60"')
    expect(html).toMatch(/class="grade[^"]*"[^>]*>D</)
    for (const label of ['Critical', 'High', 'Medium', 'Low']) expect(html).toContain(label)
  })

  it('draws the dial with the score already in the markup, so it is right with JS off', () => {
    expect(html).toMatch(/class="score-value"[^>]*>60</)
    expect((html.match(/class="tick lit"/g) ?? []).length).toBe(60)
    expect((html.match(/class="tick"/g) ?? []).length).toBe(40)
  })

  it('respects a request for less motion', () => {
    expect(html).toContain('prefers-reduced-motion')
  })

  it('groups findings by severity, most severe first, with remediation', () => {
    const order = ['Critical', 'High', 'Medium', 'Low'].map((label) => html.indexOf(`group-title">${label}`))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('create index on &quot;public&quot;.&quot;visit_notes&quot;')
  })

  it('offers a copy button for each remediation', () => {
    expect((html.match(/class="copy"/g) ?? []).length).toBe(MIXED_REPORT.findings.length)
  })

  it('carries the safety footer', () => {
    expect(html).toContain('Nothing persists, and we only ever record counts')
  })

  it('shows inconclusive probes as a caveat', () => {
    expect(html).toContain('1 probe proved nothing')
  })

  it('shows report warnings', () => {
    const warned = { ...EMPTY_REPORT, summary: { ...EMPTY_REPORT.summary, warnings: ['Careful now'] } }
    expect(renderHtmlReport(warned)).toContain('Careful now')
  })

  it('reads well for a clean report and for declared exposure', () => {
    const clean = renderHtmlReport(EMPTY_REPORT)
    expect(clean).toContain('No findings')
    expect(clean).toContain('data-score="100"')
    const declared = renderHtmlReport(DECLARED_ONLY_REPORT)
    expect(declared).toContain('Declared exposure')
    expect(declared).not.toContain('No findings')
    expect(renderHtmlReport(CRITICAL_ONLY_REPORT)).not.toContain('Declared exposure')
  })

  describe('hostile names from the scanned database', () => {
    const attack = '</script><img src=x onerror=alert(1)>"\'&'
    const hostile = {
      ...MIXED_REPORT,
      database: { ...MIXED_REPORT.database, name: attack },
      findings: [
        {
          ...MIXED_REPORT.findings[0]!,
          table: attack,
          policy: attack,
          description: attack,
          remediation: attack,
        },
      ],
      summary: {
        ...MIXED_REPORT.summary,
        warnings: [attack],
        probes: [{ schema: attack, table: attack, actor: 'anon', action: 'select_all', outcome: 'allowed', rowCount: 1 }],
      },
    } as typeof MIXED_REPORT
    const rendered = renderHtmlReport(hostile)

    it('escapes every one of them', () => {
      expect(rendered).not.toContain('<img')
      expect(rendered).not.toContain('onerror=alert(1)>')
      expect(rendered.match(/<\/script>/g)).toHaveLength(1)
      expect(rendered).toContain('&lt;/script&gt;')
      expect(rendered).toContain('&quot;')
      expect(rendered).toContain('&#39;')
      expect(rendered).toContain('&amp;')
    })

    it('neutralizes control characters too', () => {
      const withControl = {
        ...MIXED_REPORT,
        findings: [{ ...MIXED_REPORT.findings[0]!, table: 'a\u001b[31mb' }],
      }
      expect(renderHtmlReport(withControl)).not.toContain('\u001b')
    })

    it('has no inline event handlers, so the CSP can stay strict about them', () => {
      expect(renderHtmlReport(MIXED_REPORT)).not.toMatch(/\son[a-z]+=/i)
    })
  })
})

describe('matrixRows', () => {
  const probe = (table: string, actor: string, action: string, outcome: string, rowCount: number | null) => ({
    schema: 'public',
    table,
    actor,
    action,
    outcome,
    rowCount,
  })

  const rows = (probes: readonly object[], findings: typeof MIXED_REPORT.findings = []) =>
    matrixRows({
      ...MIXED_REPORT,
      findings,
      summary: { ...MIXED_REPORT.summary, probes: probes as typeof MIXED_REPORT.summary.probes },
    })

  const cell = (result: ReturnType<typeof rows>, column: string) => result[0]?.cells.find((c) => c.column === column)

  it('has one row per table, in the order probes came', () => {
    const result = rows([probe('b', 'anon', 'select_all', 'denied', 0), probe('a', 'anon', 'select_all', 'denied', 0)])
    expect(result.map((r) => r.table)).toEqual(['public.b', 'public.a'])
  })

  it.each([
    ['anon', 'select_all', 'anon-read'],
    ['anon', 'insert_other', 'anon-insert'],
    ['anon', 'update_any', 'anon-update'],
    ['anon', 'delete_any', 'anon-delete'],
    ['user_a', 'select_own', 'own-read'],
    ['user_a', 'select_others', 'others-read'],
    ['user_a', 'select_all', 'others-read'],
    ['user_a', 'insert_other', 'others-insert'],
    ['user_a', 'update_other', 'others-update'],
    ['user_a', 'delete_other', 'others-delete'],
  ])('%s %s lands in %s', (actor, action, column) => {
    expect(cell(rows([probe('t', actor, action, 'denied', 0)]), column)?.state).toBe('denied')
  })

  it('marks a cross-user allowed cell as a leak, with its count', () => {
    expect(cell(rows([probe('t', 'user_a', 'select_others', 'allowed', 80)]), 'others-read')).toMatchObject({
      state: 'leak',
      count: 80,
    })
  })

  it('marks reading your own rows as expected, not a leak', () => {
    expect(cell(rows([probe('t', 'user_a', 'select_own', 'allowed', 40)]), 'own-read')?.state).toBe('own')
  })

  it('marks an allowed insert with no count as a leak', () => {
    expect(cell(rows([probe('t', 'user_a', 'insert_other', 'allowed', null)]), 'others-insert')).toMatchObject({
      state: 'leak',
      count: null,
    })
  })

  it.each(['inconclusive', 'not_applicable'])('marks %s as grey', (outcome) => {
    expect(cell(rows([probe('t', 'user_a', 'delete_other', outcome, null)]), 'others-delete')?.state).toBe('na')
  })

  it('marks a probe that never ran as grey', () => {
    expect(cell(rows([probe('t', 'anon', 'select_all', 'denied', 0)]), 'others-delete')?.state).toBe('na')
  })

  it('marks anon reading a declared-public table as declared, not a leak', () => {
    const declared = [{ ...DECLARED_ONLY_REPORT.findings[0]!, table: 't' }]
    expect(cell(rows([probe('t', 'anon', 'select_all', 'allowed', 3)], declared), 'anon-read')?.state).toBe('declared')
  })

  it('scales leak intensity by count, with the biggest leak at full strength', () => {
    const result = rows([
      probe('t', 'user_a', 'select_others', 'allowed', 1),
      probe('t', 'user_a', 'delete_other', 'allowed', 240),
    ])
    const small = cell(result, 'others-read')?.intensity ?? 0
    const big = cell(result, 'others-delete')?.intensity ?? 0
    expect(big).toBe(1)
    expect(small).toBeGreaterThan(0)
    expect(small).toBeLessThan(big)
  })
})

describe('the rendered matrix', () => {
  it('draws one cell per table and column', () => {
    expect(cellsOf(renderHtmlReport(MIXED_REPORT))).toBe(2 * 9)
  })

  it('draws no matrix when no probes ran', () => {
    expect(cellsOf(renderHtmlReport(EMPTY_REPORT))).toBe(0)
  })
})
