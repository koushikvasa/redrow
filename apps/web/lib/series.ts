import type { HourlyScore, RecentScore } from './types'

export interface ChartPoint {
  readonly t: number
  readonly score: number
  readonly seeded: boolean
}

const HOUR_MS = 3_600_000

/**
 * Hourly averages, then every recent scan. The recent part stays exact, so a fix shows up
 * as a step the moment it lands instead of being averaged away.
 */
export function chartPoints(
  hourly: readonly HourlyScore[],
  recent: readonly RecentScore[],
  now: number,
  windowMs: number,
): ChartPoint[] {
  const start = now - windowMs
  const exact = recent
    .map((r) => ({ t: Date.parse(r.created_at), score: r.score, seeded: r.source === 'seed' }))
    .filter((p) => p.t >= start)
    .sort((a, b) => a.t - b.t)
  const exactFrom = exact[0]?.t ?? now
  const older = hourly
    .map((h) => ({ t: Date.parse(h.hour), score: h.score, seeded: h.seeded }))
    .filter((p) => p.t >= start && p.t + HOUR_MS <= exactFrom)
    .sort((a, b) => a.t - b.t)
  return [...older, ...exact]
}

/** Runs of points, split wherever seeded history turns into real scans. They share an end point. */
export function splitBySeeded(points: readonly ChartPoint[]): ChartPoint[][] {
  const runs: ChartPoint[][] = []
  for (const point of points) {
    const current = runs.at(-1)
    if (current === undefined) {
      runs.push([point])
    } else if ((current[0] as ChartPoint).seeded === point.seeded) {
      current.push(point)
    } else {
      runs.push([current.at(-1) as ChartPoint, point].map((p, i) => (i === 0 ? { ...p, seeded: point.seeded } : p)))
    }
  }
  return runs
}

export function agoText(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 90) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

export type ScoreBand = 'good' | 'mid' | 'bad'

export const bandFor = (score: number): ScoreBand => (score >= 90 ? 'good' : score >= 60 ? 'mid' : 'bad')
