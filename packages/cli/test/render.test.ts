import { describe, expect, it } from 'vitest'
import { renderReport } from '../src/render'
import { sanitizeForTerminal, toTerminalSafeJson } from '../src/sanitize'
import { CRITICAL_ONLY_REPORT, DECLARED_ONLY_REPORT, EMPTY_REPORT, MIXED_REPORT } from './helpers'

const plain = { color: false, verbose: false }

// Built from code points so that no raw bidi or separator characters sit in this source file.
const BIDI_OVERRIDE = String.fromCodePoint(0x202e)
const LINE_SEPARATOR = String.fromCodePoint(0x2028)
const BIDI_ISOLATE = String.fromCodePoint(0x2066)

describe('renderReport snapshots', () => {
  it('empty', () => {
    expect(renderReport(EMPTY_REPORT, plain)).toMatchSnapshot()
  })

  it('mixed severity', () => {
    expect(renderReport(MIXED_REPORT, plain)).toMatchSnapshot()
  })

  it('critical only', () => {
    expect(renderReport(CRITICAL_ONLY_REPORT, plain)).toMatchSnapshot()
  })

  it('declared exposure only', () => {
    expect(renderReport(DECLARED_ONLY_REPORT, plain)).toMatchSnapshot()
  })

  it('mixed severity, verbose', () => {
    expect(renderReport(MIXED_REPORT, { color: false, verbose: true })).toMatchSnapshot()
  })
})

describe('renderReport', () => {
  it('groups by severity, most severe first', () => {
    const text = renderReport(MIXED_REPORT, plain)
    const positions = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((label) => text.indexOf(label))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('shows table, policy, probe, impact and fix for a finding', () => {
    const text = renderReport(CRITICAL_ONLY_REPORT, plain)
    for (const part of ['public.patients', 'Authenticated users can view patients', 'user_a:select_others', 'read 80 rows', 'create policy']) {
      expect(text).toContain(part)
    }
  })

  it('ends with the summary count', () => {
    const lines = renderReport(MIXED_REPORT, plain).trimEnd().split('\n')
    expect(lines.at(-1)).toContain('4 findings')
    expect(lines.at(-1)).toContain('1 critical')
  })

  it('says so when there is nothing to report', () => {
    expect(renderReport(EMPTY_REPORT, plain)).toContain('No findings')
  })

  it('colors nothing when color is off, and something when it is on', () => {
    expect(renderReport(MIXED_REPORT, plain)).not.toContain('\u001b[')
    expect(renderReport(MIXED_REPORT, { color: true, verbose: false })).toContain('\u001b[')
  })

  it('neutralizes control characters in names from the scanned database', () => {
    const hostile = {
      ...CRITICAL_ONLY_REPORT,
      findings: [
        {
          ...CRITICAL_ONLY_REPORT.findings[0]!,
          table: 'evil\u001b]0;pwned\u0007name',
          policy: 'line\nbreak',
          description: `bidi ${BIDI_OVERRIDE} reversed`,
          remediation: 'fix\r\nme',
        },
      ],
    }
    const text = renderReport(hostile, plain)
    expect(text).not.toContain('\u001b')
    expect(text).not.toContain('\u0007')
    expect(text).not.toContain(BIDI_OVERRIDE)
    expect(text).not.toContain('\r')
    expect(text).toContain('line\\u{a}break')
  })

  it('shows declared exposure as its own group, after real findings, without calling it a failure', () => {
    const text = renderReport(DECLARED_ONLY_REPORT, plain)
    expect(text).toContain('DECLARED EXPOSURE (1)')
    expect(text).toContain('Score 100/100, grade A')
    expect(text).toContain('1 declared exposure')
    expect(text).not.toContain('No findings')
    expect(text).toContain('0 findings')
  })

  it('keeps the plain counts line when nothing is declared', () => {
    expect(renderReport(CRITICAL_ONLY_REPORT, plain)).not.toContain('declared')
  })

  it('qualifies a clean result when probes were inconclusive', () => {
    const text = renderReport(
      { ...EMPTY_REPORT, summary: { ...EMPTY_REPORT.summary, inconclusive: 2 } },
      plain,
    )
    expect(text).toContain('Warning: 2 probes proved nothing')
    expect(text).toContain('(2 inconclusive)')
  })

  it('shows warnings, with database names neutralized', () => {
    const text = renderReport(
      { ...EMPTY_REPORT, summary: { ...EMPTY_REPORT.summary, warnings: ['Not probed: a\u001b[31mb'] } },
      plain,
    )
    expect(text).toContain('Warning: Not probed:')
    expect(text).not.toContain('\u001b')
  })

  it('neutralizes control characters in the matrix too', () => {
    const hostile = {
      ...MIXED_REPORT,
      summary: {
        ...MIXED_REPORT.summary,
        probes: [
          { schema: 'public', table: 'x\u001b[31m', actor: 'anon', action: 'select_all', outcome: 'denied', rowCount: 0 },
        ],
      },
    } as typeof MIXED_REPORT
    expect(renderReport(hostile, plain)).not.toContain('\u001b')
  })
})

describe('toTerminalSafeJson', () => {
  const value = { name: `a${BIDI_OVERRIDE}b${String.fromCodePoint(0x85)}c`, ok: 'patients_é', lines: ['x', 'y'] }

  it('leaves no raw bidi or C1 control in the output', () => {
    const json = toTerminalSafeJson(value)
    expect(json).not.toContain(BIDI_OVERRIDE)
    expect(json).not.toContain(String.fromCodePoint(0x85))
    expect(json).toContain('\\u202e')
  })

  it('round-trips to exactly the same data', () => {
    expect(JSON.parse(toTerminalSafeJson(value))).toEqual(value)
  })

  it('keeps the pretty-printing newlines', () => {
    expect(toTerminalSafeJson(value).split('\n').length).toBeGreaterThan(1)
  })
})

describe('sanitizeForTerminal', () => {
  it('leaves ordinary text, including non-ASCII names, alone', () => {
    expect(sanitizeForTerminal('patients_é_日本 "quoted"')).toBe('patients_é_日本 "quoted"')
  })

  it.each([
    ['escape', '\u001b', '\\u{1b}'],
    ['newline', '\n', '\\u{a}'],
    ['null', '\u0000', '\\u{0}'],
    ['C1 control', '\u0085', '\\u{85}'],
    ['line separator', LINE_SEPARATOR, '\\u{2028}'],
    ['bidi override', BIDI_OVERRIDE, '\\u{202e}'],
    ['bidi isolate', BIDI_ISOLATE, '\\u{2066}'],
  ])('escapes %s visibly', (_label, input, expected) => {
    expect(sanitizeForTerminal(`a${input}b`)).toBe(`a${expected}b`)
  })
})
