import type { Sql } from 'postgres'
import type { ScanRows } from './engine/index.js'

/** One scan and its rows, all or nothing. Insert-only: nothing here updates or deletes. */
export async function insertScan(sql: Sql, rows: ScanRows): Promise<string> {
  return await sql.begin(async (tx) => {
    const [inserted] = await tx<{ id: string }[]>`insert into public.scan_runs ${tx(rows.run as never)} returning id`
    const scanRunId = (inserted as { id: string }).id
    if (rows.findings.length > 0) {
      await tx`insert into public.findings ${tx(rows.findings.map((f) => ({ ...f, scan_run_id: scanRunId })) as never)}`
    }
    if (rows.probes.length > 0) {
      await tx`insert into public.probe_results ${tx(rows.probes.map((p) => ({ ...p, scan_run_id: scanRunId })) as never)}`
    }
    return scanRunId
  })
}

export const CONNECTION_OPTIONS = {
  ssl: 'require',
  // Each TLS handshake costs compute, and an edge function's budget is small.
  max: 2,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 5,
  onnotice: () => {},
} as const
