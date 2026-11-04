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
      className="shrink-0 cursor-pointer border border-faint px-3 py-2 text-sm text-dim hover:border-ink hover:text-ink focus-visible:border-ink focus-visible:text-ink"
    >
      {status}
    </button>
  )
}
