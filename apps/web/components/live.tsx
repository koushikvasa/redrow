'use client'

import { createBrowserClient } from '@supabase/ssr'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { agoText } from '@/lib/series'

const REFRESH_DEBOUNCE_MS = 1000
/** If Realtime can't connect, the page still has to stay current on a projector. */
const FALLBACK_POLL_MS = 30_000
/** A sweep runs every minute, so this long without one means they've stopped. */
const STALE_MS = 180_000

/** Re-renders the page's server data whenever a scan lands for this project, or for any on the board. */
export function LiveRefresh({ projectId }: { readonly projectId?: string }) {
  const router = useRouter()
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const db = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    )
    let pending: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      clearTimeout(pending)
      pending = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }
    const filter = projectId === undefined ? {} : { filter: `project_id=eq.${projectId}` }
    const channel = db
      .channel(`scans-${projectId ?? 'board'}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scan_runs', ...filter }, refresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'findings', ...filter }, refresh)
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'))
    return () => {
      clearTimeout(pending)
      void db.removeChannel(channel)
    }
  }, [projectId, router])

  useEffect(() => {
    if (connected) return
    const poll = setInterval(() => router.refresh(), FALLBACK_POLL_MS)
    return () => clearInterval(poll)
  }, [connected, router])

  return (
    <span className="flex items-center gap-2 text-sm text-dim">
      <i className={`inline-block size-2 rounded-full ${connected ? 'live-dot bg-ok' : 'bg-faint'}`} />
      {connected ? 'live' : 'connecting'}
    </span>
  )
}

/** Ticks every second. Blank until mounted, because the server's clock isn't the viewer's. */
export function ScannedAgo({ at }: { readonly at: string }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [])
  if (now === null) return <span className="text-sm text-dim">last scanned …</span>
  const elapsed = now - Date.parse(at)
  return (
    <span className={`text-sm tabular-nums ${elapsed > STALE_MS ? 'text-amber' : 'text-dim'}`}>
      last scanned {agoText(elapsed)}
    </span>
  )
}
