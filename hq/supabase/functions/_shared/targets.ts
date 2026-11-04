export interface Target {
  readonly project: string
  readonly urlEnv: string
  /** The judges' board is meant to be readable by anon, so that read scores nothing. */
  readonly publicTables: readonly string[]
  /** Pins user A, so the dashboard's "Dr. Ana" is literally her. Matches actors in hq/redrow.config.json. */
  readonly userAEmail?: string
}

// HQ is scanned through its session pooler, like any other target. A scan over
// SUPABASE_DB_URL never finishes on the edge, though storing a result over it works.
export const TARGETS: readonly Target[] = [
  { project: 'CareNote demo', urlEnv: 'DEMO_DB_URL', publicTables: [], userAEmail: 'dr.ana@carenote.test' },
  { project: 'Red Row HQ (self-scan)', urlEnv: 'HQ_POOLER_DB_URL', publicTables: ['projects'] },
]
