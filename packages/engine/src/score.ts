import type { Finding, Grade, Severity, SeverityCounts } from './types'

const SEVERITY_WEIGHTS: Readonly<Record<Severity, number>> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
}

/** Most severe first. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low']

/** True when `severity` is at least as serious as `threshold`. */
export const meetsSeverity = (severity: Severity, threshold: Severity): boolean =>
  SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(threshold)

/** Keeps performance hints from dominating the score. */
const LOW_PENALTY_CAP = 10

const MAX_SCORE = 100

const GRADE_THRESHOLDS: readonly (readonly [number, Grade])[] = [
  [90, 'A'],
  [75, 'B'],
  [60, 'C'],
  [40, 'D'],
]

export interface ScoreSummary {
  readonly score: number
  readonly grade: Grade
  readonly counts: SeverityCounts
}

const countOf = (findings: readonly Finding[], severity: Severity): number =>
  findings.filter((f) => f.severity === severity).length

function gradeFor(score: number, hasCritical: boolean): Grade {
  const grade = GRADE_THRESHOLDS.find(([minimum]) => score >= minimum)?.[1] ?? 'F'
  // Any critical caps the grade at D, however high the score is.
  return hasCritical && grade !== 'F' ? 'D' : grade
}

/** ENGINE.md §4. */
export function scoreFindings(findings: readonly Finding[]): ScoreSummary {
  const counts: SeverityCounts = {
    critical: countOf(findings, 'critical'),
    high: countOf(findings, 'high'),
    medium: countOf(findings, 'medium'),
    low: countOf(findings, 'low'),
  }
  const penalty =
    counts.critical * SEVERITY_WEIGHTS.critical +
    counts.high * SEVERITY_WEIGHTS.high +
    counts.medium * SEVERITY_WEIGHTS.medium +
    Math.min(counts.low * SEVERITY_WEIGHTS.low, LOW_PENALTY_CAP)
  const score = Math.max(0, MAX_SCORE - penalty)
  return { score, grade: gradeFor(score, counts.critical > 0), counts }
}
