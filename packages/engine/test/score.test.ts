import { describe, expect, it } from 'vitest'
import { scoreFindings } from '../src/score'
import type { Finding, Severity } from '../src/types'

const findings = (severity: Severity, count: number): Finding[] =>
  Array.from({ length: count }, () => ({
    ruleId: 'RR001',
    severity,
    schema: 'public',
    title: 't',
    detail: 'd',
    fixHint: 'f',
  }))

describe('scoreFindings', () => {
  it('scores a clean scan 100 / A', () => {
    expect(scoreFindings([])).toEqual({
      score: 100,
      grade: 'A',
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
    })
  })

  it.each([
    ['high', 90],
    ['medium', 96],
    ['low', 99],
    ['critical', 75],
  ] as const)('deducts the weight of one %s finding', (severity, expected) => {
    expect(scoreFindings(findings(severity, 1)).score).toBe(expected)
  })

  it('sums penalties and counts by severity', () => {
    const result = scoreFindings([...findings('critical', 1), ...findings('high', 2), ...findings('medium', 1)])
    expect(result.score).toBe(100 - 25 - 20 - 4)
    expect(result.counts).toEqual({ critical: 1, high: 2, medium: 1, low: 0 })
  })

  it('caps low-severity penalties at 10 but still counts every finding', () => {
    const result = scoreFindings(findings('low', 50))
    expect(result.score).toBe(90)
    expect(result.counts.low).toBe(50)
  })

  it('never goes below 0', () => {
    expect(scoreFindings(findings('critical', 9)).score).toBe(0)
  })

  it.each([
    [0, 'A', 100],
    [1, 'A', 90],
    [2, 'B', 80],
    [3, 'C', 70],
    [4, 'C', 60],
    [5, 'D', 50],
    [6, 'D', 40],
    [7, 'F', 30],
  ] as const)('grades %i high findings as %s', (count, grade, score) => {
    expect(scoreFindings(findings('high', count))).toMatchObject({ grade, score })
  })

  it('caps the grade at D when any critical exists, even with a passing score', () => {
    const result = scoreFindings(findings('critical', 1))
    expect(result.score).toBe(75)
    expect(result.grade).toBe('D')
  })

  it('does not raise an F to D because of the critical cap', () => {
    expect(scoreFindings(findings('critical', 3)).grade).toBe('F')
  })
})
