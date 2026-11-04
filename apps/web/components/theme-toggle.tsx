'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { THEME_KEY, parseThemeChoice, type ThemeChoice } from '@/lib/theme'

const svgProps = { viewBox: '0 0 16 16', 'aria-hidden': true, className: 'size-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 } as const

const OPTIONS: readonly { readonly choice: ThemeChoice; readonly label: string; readonly icon: ReactNode }[] = [
  {
    choice: 'system',
    label: 'Use system theme',
    icon: (
      <svg {...svgProps}>
        <rect x="2" y="3" width="12" height="8" />
        <path d="M5.5 13.5h5M8 11v2.5" />
      </svg>
    ),
  },
  {
    choice: 'light',
    label: 'Use light theme',
    icon: (
      <svg {...svgProps}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" />
      </svg>
    ),
  },
  {
    choice: 'dark',
    label: 'Use dark theme',
    icon: (
      <svg {...svgProps}>
        <path d="M13.5 9.8A5.8 5.8 0 0 1 6.2 2.5a5.8 5.8 0 1 0 7.3 7.3Z" />
      </svg>
    ),
  },
]

/** The page's attribute is the truth. Storage only remembers it, so a blocked store just means no memory. */
function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === 'system') delete root.dataset.theme
  else root.dataset.theme = choice
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, choice)
  } catch {
    // Private windows can refuse storage. The theme still applies for this page view.
  }
}

export function ThemeToggle() {
  const [current, setCurrent] = useState<ThemeChoice>('system')
  useEffect(() => setCurrent(parseThemeChoice(document.documentElement.dataset.theme)), [])
  return (
    <div role="group" aria-label="Theme" className="theme-toggle">
      {OPTIONS.map(({ choice, label, icon }) => (
        <button
          key={choice}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={current === choice}
          className="theme-option"
          onClick={() => {
            applyTheme(choice)
            setCurrent(choice)
          }}
        >
          {icon}
        </button>
      ))}
    </div>
  )
}
