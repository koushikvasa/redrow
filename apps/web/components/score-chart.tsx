import { bandFor, splitBySeeded, type ChartPoint } from '@/lib/series'

const WIDTH = 640
const HEIGHT = 170
const PAD = { top: 10, right: 8, bottom: 22, left: 34 }
const GRIDLINES = [0, 50, 100]

interface ChartProps {
  readonly title: string
  readonly points: readonly ChartPoint[]
  readonly from: number
  readonly to: number
  readonly startLabel: string
}

export function ScoreChart({ title, points, from, to, startLabel }: ChartProps) {
  const x = (t: number): number => PAD.left + ((t - from) / (to - from)) * (WIDTH - PAD.left - PAD.right)
  const y = (score: number): number => PAD.top + ((100 - score) / 100) * (HEIGHT - PAD.top - PAD.bottom)
  const latest = points.at(-1)
  return (
    <figure className={`band-${bandFor(latest?.score ?? 0)} border border-line bg-panel p-4`}>
      <figcaption className="mb-2 flex justify-between text-sm text-dim">
        <span className="uppercase tracking-[0.14em]">{title}</span>
        {latest === undefined ? null : <span className="tabular-nums text-ink">now {latest.score}</span>}
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block w-full"
        role="img"
        aria-label={latest === undefined ? `${title}: no scans yet` : `${title}: ${points.length} points, currently ${latest.score}`}
      >
        {GRIDLINES.map((score) => (
          <g key={score}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(score)} y2={y(score)} stroke="var(--color-line)" />
            <text x={PAD.left - 8} y={y(score) + 4} textAnchor="end" fontSize="12" fill="var(--color-dim)">
              {score}
            </text>
          </g>
        ))}
        {splitBySeeded(points).map((run) => (
          <polyline
            key={run[0]?.t}
            points={run.map((p) => `${x(p.t).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')}
            fill="none"
            stroke={run[0]?.seeded ? 'var(--color-faint)' : 'var(--band)'}
            strokeWidth="2"
            strokeDasharray={run[0]?.seeded ? '3 4' : undefined}
          />
        ))}
        {latest === undefined ? null : <circle cx={x(latest.t)} cy={y(latest.score)} r="4" fill="var(--band)" />}
        <text x={PAD.left} y={HEIGHT - 4} fontSize="12" fill="var(--color-dim)">
          {startLabel}
        </text>
        <text x={WIDTH - PAD.right} y={HEIGHT - 4} textAnchor="end" fontSize="12" fill="var(--color-dim)">
          now
        </text>
      </svg>
    </figure>
  )
}
