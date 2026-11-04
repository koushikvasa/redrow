'use client'

import { useState, type ReactNode } from 'react'

const segment = (isActive: boolean): string =>
  `cursor-pointer px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${
    isActive ? 'bg-ink text-bg' : 'text-dim hover:text-ink'
  }`

/** Before and after. Each side remounts when shown, so the dial and the replay run again. */
export function FixedToggle({ live, fixed }: { readonly live: ReactNode; readonly fixed: ReactNode }) {
  const [isFixed, setIsFixed] = useState(false)
  return (
    <>
      <div role="group" aria-label="Before and after the fix" className="mt-2 inline-flex border border-faint">
        <button type="button" aria-pressed={!isFixed} onClick={() => setIsFixed(false)} className={segment(!isFixed)}>
          Leaking now
        </button>
        <button type="button" aria-pressed={isFixed} onClick={() => setIsFixed(true)} className={segment(isFixed)}>
          See it fixed
        </button>
      </div>
      {isFixed ? fixed : live}
    </>
  )
}
