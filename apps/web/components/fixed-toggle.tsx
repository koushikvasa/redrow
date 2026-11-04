'use client'

import { useState, type ReactNode } from 'react'

/** Before and after. Each side remounts when shown, so the dial and the replay run again. */
export function FixedToggle({ live, fixed }: { readonly live: ReactNode; readonly fixed: ReactNode }) {
  const [isFixed, setIsFixed] = useState(false)
  return (
    <>
      <div role="group" aria-label="Before and after the fix" data-fixed={isFixed} className="fix-toggle mt-3 mb-4">
        <span aria-hidden="true" className="fix-thumb" />
        <button type="button" aria-pressed={!isFixed} onClick={() => setIsFixed(false)} className="fix-option">
          Leaking now
        </button>
        <button type="button" aria-pressed={isFixed} onClick={() => setIsFixed(true)} className="fix-option">
          See it fixed
        </button>
      </div>
      {isFixed ? fixed : live}
    </>
  )
}
