'use client'

import { useEffect, useState } from 'react'
import type { ReplayLine } from '@/lib/story'
import { LockIcon } from './lock-icon'

const LINE_MS = 400

type Props = {
  readonly lines: readonly ReplayLine[]
  readonly blocked: number
  /** Changes when what got through changes, which replays the strip. */
  readonly replayKey: string
  readonly title: string
}

/** How far through the replay this line is, from 0 to 1. */
const progressOf = (elapsed: number, index: number): number => Math.min(1, Math.max(0, (elapsed - index * LINE_MS) / LINE_MS))

/** Zero width, so it can't reflow the strip while it moves. */
const Caret = () => <span className="caret" />

type TypedLineProps = { readonly line: ReplayLine; readonly progress: number; readonly hasCaret: boolean }

function TypedLine({ line, progress, hasCaret }: TypedLineProps) {
  const action = `${line.action} `
  const typed = Math.floor(progress * (action.length + line.result.length))
  const isResultVisible = typed > action.length
  const resultTyped = Math.max(0, typed - action.length)
  return (
    // The untyped part stays in place, invisible, so the strip doesn't jump as it fills.
    <li className="min-h-[1.5em] [overflow-wrap:anywhere]">
      <span className="text-soft">{action.slice(0, typed)}</span>
      {hasCaret && !isResultVisible ? <Caret /> : null}
      <span className="invisible">{action.slice(typed)}</span>
      <span className="whitespace-nowrap font-bold text-leak">
        <LockIcon isOpen isUnlocking={isResultVisible} className={`mr-1.5 align-[-0.1em] ${isResultVisible ? '' : 'invisible'}`} />
        {line.result.slice(0, resultTyped)}
        {hasCaret && isResultVisible ? <Caret /> : null}
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
  const caretLine = Math.min(steps - 1, Math.floor(elapsed / LINE_MS))
  return (
    <section aria-label="Attack replay" className="border border-line bg-sunken px-4 py-3 font-mono text-sm sm:text-[0.95rem]">
      <h2 className="eyebrow mb-2">{title}</h2>
      <ul className="sr-only">
        {lines.map((line) => (
          <li key={line.action}>{`${line.action} got through: ${line.result}`}</li>
        ))}
        {blocked > 0 ? <li>{blockedText}</li> : null}
      </ul>
      <ol aria-hidden="true" className="leading-relaxed">
        {lines.map((line, index) => (
          <TypedLine key={line.action} line={line} progress={progressOf(elapsed, index)} hasCaret={caretLine === index} />
        ))}
        {blocked > 0 ? (
          <li
            className="min-h-[1.5em] text-dim transition-opacity duration-300"
            style={{ opacity: progressOf(elapsed, lines.length) > 0 ? 1 : 0 }}
          >
            {blockedText} <LockIcon isOpen={false} className="ml-0.5 align-[-0.1em]" />
            {caretLine === lines.length ? <span className="ml-1.5 inline-block"><Caret /></span> : null}
          </li>
        ) : null}
      </ol>
    </section>
  )
}
