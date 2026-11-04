/** Drawn rather than an emoji: it takes the text colour, and looks the same on every device. */
export function LockIcon({ isOpen, className = '' }: { readonly isOpen: boolean; readonly className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`inline-block size-[1em] shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="2.75" y="7" width="10.5" height="7.25" rx="1" fill="currentColor" stroke="none" />
      <path d={isOpen ? 'M5 7V4.5a3 3 0 0 1 5.8-1.1' : 'M5 7V4.5a3 3 0 0 1 6 0V7'} strokeLinecap="round" />
    </svg>
  )
}
