'use client'

import { useEffect, useRef, useState } from 'react'

const TICKS = 100
const SWEEP_DEGREES = 270
const START_DEGREES = -135
const COUNT_MS_PER_POINT = 9
const COUNT_MIN_MS = 350

const durationFor = (distance: number): number => distance * COUNT_MS_PER_POINT + COUNT_MIN_MS

/** Counts from the last shown score to the new one. The server already rendered the final number. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target)
  const from = useRef(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(target)
      from.current = target
      return
    }
    const start = performance.now()
    const origin = from.current
    const duration = durationFor(Math.abs(target - origin))
    let frame = requestAnimationFrame(function step(now) {
      const done = Math.min(1, (now - start) / duration)
      setShown(Math.round(origin + (target - origin) * done))
      if (done < 1) frame = requestAnimationFrame(step)
    })
    from.current = target
    return () => cancelAnimationFrame(frame)
  }, [target])
  return shown
}

const needleAngle = (score: number): number => START_DEGREES + (SWEEP_DEGREES * Math.max(0, score - 1)) / (TICKS - 1)

type Props = {
  readonly score: number
  readonly grade: string
  readonly size: 'lg' | 'sm'
  /** Red is only for a real open door, not for a low score on its own. */
  readonly hasOpenDoors: boolean
}

export function ScoreDial({ score, grade, size, hasOpenDoors }: Props) {
  const shown = useCountUp(score)
  // Smaller on a phone, so the plain-English headline isn't pushed off the first screen.
  const dimension = size === 'lg' ? 'w-[230px] sm:w-[280px] 2xl:w-[360px]' : 'w-[190px]'
  const number = size === 'lg' ? 'text-[72px] sm:text-[88px] 2xl:text-[116px]' : 'text-[58px]'
  const sweep = durationFor(score)
  const motion = {
    '--to': `${needleAngle(score).toFixed(2)}deg`,
    '--sweep': `${sweep}ms`,
    '--stamp-delay': `${Math.max(sweep - 120, 700)}ms`,
  } as React.CSSProperties
  return (
    <div
      className={`${hasOpenDoors ? 'tone-leak' : 'tone-neutral'} relative aspect-square shrink-0 ${dimension}`}
      style={motion}
      role="img"
      aria-label={`Score ${score} out of 100, grade ${grade}`}
    >
      <svg viewBox="0 0 380 380" aria-hidden="true" className="block size-full overflow-visible">
        {Array.from({ length: TICKS }, (_, i) => (
          <line
            key={i}
            className={i < score ? 'tick tick-lit' : 'tick'}
            style={{ '--i': i } as React.CSSProperties}
            x1="190"
            y1="14"
            x2="190"
            y2={i % 10 === 0 ? 40 : 30}
            transform={`rotate(${(START_DEGREES + (SWEEP_DEGREES * i) / (TICKS - 1)).toFixed(2)} 190 190)`}
          />
        ))}
        <line className={`needle ${score === 0 ? 'needle-falls' : ''}`} x1="190" y1="6" x2="190" y2="54" />
      </svg>
      <div className="dial-readout absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
        <div className={`font-display leading-none tabular-nums text-[var(--tone)] ${number}`}>{shown}</div>
        <div className="mt-1 font-mono text-xs tracking-[0.2em] text-dim sm:text-sm">/ 100</div>
        <div className="stamp mt-2 border-2 border-[var(--tone)] px-3 font-mono font-bold tracking-widest text-[var(--tone)] sm:text-xl">{grade}</div>
      </div>
    </div>
  )
}
