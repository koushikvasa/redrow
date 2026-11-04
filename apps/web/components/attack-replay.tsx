'use client'

import { useEffect, useState } from 'react'
import type { ReplayLine } from '@/lib/story'
import { LockIcon } from './lock-icon'

const LINE_MS = 400

type Props = {
  readonly lines: readonly ReplayLine[]
  readonly blocked: number
  /** Changes when a new scan lands, which replays the strip. */
  readonly replayKey: string
  readonly title: string
}

/** How far through the replay this line is, from 0 to 1. */
const progressOf = (elapsed: number, index: number): number => Math.min(1, Math.max(0, (elapsed - index * LINE_MS) / LINE_MS))

function TypedLine({ line, progress }: { readonly line: ReplayLine; readonly progress: number }) {
  const action = `${line.action} `
  const typed = Math.floor(progress * (action.length + line.result.length))
  const isResultVisible = typed > action.length
  const resultTyped = Math.max(0, typed - action.length)
  return (
    // The untyped part stays in place, invisible, so the strip doesn't jump as it fills.
    <li className="min-h-[1.5em] [overflow-wrap:anywhere]">
      <span className="text-[#c9c8c2]">{action.slice(0, typed)}</span>
      <span className="invisible">{action.slice(typed)}</span>
      <span className="whitespace-nowrap font-bold text-leak">
        <LockIcon isOpen className={`mr-1.5 align-[-0.1em] ${isResultVisible ? '' : 'invisible'}`} />
        {line.result.slice(0, resultTyped)}
        <span className="invisible">{line.result.slice(resultTyped)}</span>
      </span>
    </li>
  )
}

function useReplayClock(replayKey: string, lineCount: number): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setElapsed(Number.POSITIVE_INFINITY)
      return
    }
    const start = performance.now()
    const end = lineCount * LINE_MS
    setElapsed(0)
    let frame = requestAnimationFrame(function step(now) {
      setElapsed(now - start)
      if (now - start < end) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [replayKey, lineCount])
  return elapsed
}

export function AttackReplay({ lines, blocked, replayKey, title }: Props) {
  const steps = lines.length + (blocked > 0 ? 1 : 0)
  const elapsed = useReplayClock(replayKey, steps)
  const blockedText = `${lines.length > 0 ? '…and ' : ''}${blocked} ${blocked === 1 ? 'attempt' : 'attempts'} blocked`
  return (
    <section aria-label="Attack replay" className="border border-line bg-[#07080a] px-4 py-3 text-sm sm:text-base">
      <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-[0.2em] text-dim">{title}</h2>
      <ul className="sr-only">
        {lines.map((line) => (
          <li key={line.action}>{`${line.action} got through: ${line.result}`}</li>
        ))}
        {blocked > 0 ? <li>{blockedText}</li> : null}
      </ul>
      <ol aria-hidden="true" className="leading-relaxed">
        {lines.map((line, index) => (
          <TypedLine key={line.action} line={line} progress={progressOf(elapsed, index)} />
        ))}
        {blocked > 0 ? (
          <li
            className="min-h-[1.5em] text-dim transition-opacity duration-300"
            style={{ opacity: progressOf(elapsed, lines.length) > 0 ? 1 : 0 }}
          >
            {blockedText} <LockIcon isOpen={false} className="ml-0.5 align-[-0.1em] opacity-70" />
          </li>
        ) : null}
      </ol>
    </section>
  )
}
