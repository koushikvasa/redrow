'use client'

import { useEffect, useRef, useState } from 'react'
import { bandFor } from '@/lib/series'

const TICKS = 100
const SWEEP_DEGREES = 270
const START_DEGREES = -135
const COUNT_MS_PER_POINT = 9
const COUNT_MIN_MS = 350

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
    const duration = Math.abs(target - origin) * COUNT_MS_PER_POINT + COUNT_MIN_MS
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

export function ScoreDial({ score, grade, size }: { readonly score: number; readonly grade: string; readonly size: 'lg' | 'sm' }) {
  const shown = useCountUp(score)
  // Smaller on a phone, so the plain-English headline isn't pushed off the first screen.
  const dimension = size === 'lg' ? 'w-[230px] sm:w-[380px]' : 'w-[210px]'
  const number = size === 'lg' ? 'text-[72px] sm:text-[124px]' : 'text-[62px]'
  return (
    <div
      className={`band-${bandFor(score)} relative aspect-square shrink-0 ${dimension}`}
      role="img"
      aria-label={`Score ${score} out of 100, grade ${grade}`}
    >
      <svg viewBox="0 0 380 380" aria-hidden="true" className="block size-full">
        {Array.from({ length: TICKS }, (_, i) => (
          <line
            key={i}
            className={i < score ? 'tick tick-lit' : 'tick'}
            style={{ '--i': i } as React.CSSProperties}
            x1="190"
            y1="14"
            x2="190"
            y2={i % 10 === 0 ? 44 : 36}
            transform={`rotate(${(START_DEGREES + (SWEEP_DEGREES * i) / (TICKS - 1)).toFixed(2)} 190 190)`}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden="true">
        <div className={`font-bold leading-none tabular-nums text-[var(--band)] ${number}`}>{shown}</div>
        <div className="mt-1 text-sm tracking-[0.2em] text-dim">/ 100</div>
        <div className="mt-2 border-2 border-[var(--band)] px-3 font-bold tracking-widest text-[var(--band)] sm:text-xl">{grade}</div>
      </div>
    </div>
  )
}
