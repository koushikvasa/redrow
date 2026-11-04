'use client'

export default function ErrorPage({ reset }: { readonly reset: () => void }) {
  return (
    <main className="py-16">
      <h1 className="text-3xl font-bold">Can&apos;t reach HQ right now.</h1>
      <p className="mt-3 text-dim">The scans are still running. This page just couldn&apos;t load them.</p>
      <button type="button" onClick={reset} className="mt-6 cursor-pointer border border-ink px-4 py-2 font-semibold hover:bg-ink hover:text-bg">
        Try again
      </button>
    </main>
  )
}
