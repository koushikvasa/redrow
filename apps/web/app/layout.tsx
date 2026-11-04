import type { Metadata } from 'next'
import { Gloock, Instrument_Sans, JetBrains_Mono } from 'next/font/google'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ThemeToggle } from '@/components/theme-toggle'
import { themeInitScript } from '@/lib/theme'
import './globals.css'

// next/font self-hosts these at build time, so the page makes no font requests to anyone else.
const display = Gloock({ weight: '400', subsets: ['latin'], variable: '--font-gloock', display: 'swap' })
const body = Instrument_Sans({ subsets: ['latin'], variable: '--font-instrument', display: 'swap' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap', preload: false })

export const metadata: Metadata = {
  title: 'Red Row: AI wrote your RLS. Red Row proves whether it leaks.',
  description: 'Attacks Supabase Row Level Security with simulated users and reports who can read or write what, with real row counts.',
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    // The script below sets data-theme before hydration, which React would otherwise flag.
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* A constant from lib/theme.ts, with no outside input. Must run before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <div className="mx-auto max-w-[1780px] px-4 py-4 sm:px-10 sm:py-5 lg:px-14">
          <header className="masthead flex items-center justify-between gap-4 pb-3">
            <Link href="/" className="font-display text-2xl leading-none tracking-[0.06em] sm:text-3xl">
              RED<span className="text-dim">ROW</span>
            </Link>
            <div className="flex items-center gap-4 sm:gap-6">
              <a href="https://github.com/koushikvasa/redrow" className="text-sm text-dim underline-offset-4 hover:text-ink hover:underline">
                GitHub
              </a>
              <ThemeToggle />
            </div>
          </header>
          {children}
          <footer className="mt-16 flex justify-end border-t border-line pt-4 text-sm text-dim">
            <span>Open source, MIT</span>
          </footer>
        </div>
      </body>
    </html>
  )
}
