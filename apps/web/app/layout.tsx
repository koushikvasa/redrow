import type { Metadata } from 'next'
import { JetBrains_Mono } from 'next/font/google'
import Link from 'next/link'
import type { ReactNode } from 'react'
import './globals.css'

const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains' })

export const metadata: Metadata = {
  title: 'Red Row: AI wrote your RLS. Red Row proves whether it leaks.',
  description: 'Attacks Supabase Row Level Security with simulated users and reports who can read or write what, with real row counts.',
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={mono.variable}>
      <body>
        <div className="mx-auto max-w-[1780px] px-4 py-6 sm:px-10 lg:px-14">
          <header className="flex items-baseline justify-between gap-6 border-b border-line pb-4">
            <Link href="/" className="text-lg font-bold tracking-[0.32em]">
              RED<span className="text-leak">ROW</span>
            </Link>
            <a href="https://github.com/koushikvasa/redrow" className="text-sm text-dim hover:text-ink">
              GitHub
            </a>
          </header>
          {children}
          <footer className="mt-12 flex flex-wrap justify-between gap-4 border-t border-line pt-4 text-sm text-dim">
            <span>
              <strong className="font-semibold text-ink">Nothing persists, and we only ever record counts.</strong> Every probe
              runs in a transaction that is rolled back.
            </span>
            <span>Open source, MIT</span>
          </footer>
        </div>
      </body>
    </html>
  )
}
