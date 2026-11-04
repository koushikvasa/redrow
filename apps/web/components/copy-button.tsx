'use client'

import { useState } from 'react'

const RESET_MS = 1500

export function CopyButton({ text, label = 'Copy' }: { readonly text: string; readonly label?: string }) {
  const [status, setStatus] = useState<string>(label)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setStatus('Copied')
    } catch {
      setStatus('Press Ctrl+C')
    }
    setTimeout(() => setStatus(label), RESET_MS)
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 cursor-pointer border border-line-strong px-3 py-2 font-mono text-sm text-dim transition-colors hover:border-ink hover:text-ink focus-visible:border-ink focus-visible:text-ink"
    >
      {status}
    </button>
  )
}
