import type { Sql } from 'postgres'
import { chooseActors, resolveActors } from './actors'
import { mapConcurrent } from './concurrency'
import { applyDeclaredExposure } from './declared'
import { findingsFromProbes, mergeFindings, tableKey } from './dynamic'
import { introspect } from './introspect'
import { gatherTableStats, isProbeable, runTableProbes } from './probes'
import { scoreFindings } from './score'
import { runStaticRules } from './static'
import type {
  Actors,
  Introspection,
  ScanOptions,
  ScanResult,
  TableInfo,
  TableSummary,
} from './types'

export const ENGINE_VERSION = '0.1.0'

const DEFAULT_SCHEMAS: readonly string[] = ['public']

/** Tables probed at once. Probes within one table always run one after another. */
const TABLE_CONCURRENCY = 4

const toTableSummary = (table: TableInfo, totalRows: number | null): TableSummary => ({
  schema: table.schema,
  table: table.table,
  rlsEnabled: table.rlsEnabled,
  ...(table.ownerColumn === undefined ? {} : { ownerColumn: table.ownerColumn }),
  totalRows,
  sensitive: table.sensitive,
})

function limitToTables(introspection: Introspection, tables: readonly string[] | undefined): Introspection {
  if (tables === undefined || tables.length === 0) return introspection
  const known = new Set(introspection.tables.map((t) => t.table))
  const unknown = tables.filter((name) => !known.has(name))
  if (unknown.length > 0) {
    throw new Error(`No such table in the scanned schemas: ${unknown.join(', ')}`)
  }
  return {
    tables: introspection.tables.filter((t) => tables.includes(t.table)),
    policies: introspection.policies.filter((p) => tables.includes(p.table)),
    views: [],
    functions: [],
  }
}

/** A role that doesn't bypass RLS undercounts rows, and leaks can hide behind low counts. */
async function connectingRoleWarnings(sql: Sql): Promise<string[]> {
  const rows = await sql<{ role: string; bypass: boolean }[]>`
    select current_user::text as role, (rolsuper or rolbypassrls) as bypass
    from pg_roles where rolname = current_user`
  const self = rows[0]
  if (self === undefined || self.bypass) return []
  return [
    `The connecting role ${self.role} doesn't bypass RLS, so row counts may be low and leaks can be missed. Connect as the postgres role.`,
  ]
}

const unprobeableWarnings = (tables: readonly TableInfo[]): string[] =>
  tables
    .filter((t) => !isProbeable(t))
    .map((t) => `Not probed: ${t.schema}.${t.table}. Its name or owner column contains a dot, so only its policies were checked.`)

/** Introspect, apply static rules, pick actors, probe, score. Every probe is rolled back. */
export async function scan(sql: Sql, opts: ScanOptions = {}): Promise<ScanResult> {
  const schemas = opts.schemas ?? DEFAULT_SCHEMAS
  if (schemas.length === 0) {
    throw new Error('scan: at least one schema is required')
  }
  const startedAtMs = Date.now()

  opts.onPhase?.('introspect')
  const introspection = limitToTables(await introspect(sql, schemas, opts.ownerColumns), opts.tables)
  const staticFindings = runStaticRules(introspection)

  opts.onPhase?.('actors')
  const roleWarnings = await connectingRoleWarnings(sql)
  const stats = await mapConcurrent(introspection.tables, TABLE_CONCURRENCY, (t) =>
    gatherTableStats(sql, t, opts.readOnly ?? false),
  )
  const actors: Actors =
    opts.actors ?? (await resolveActors(sql, chooseActors(stats.map((s) => s.owners))))

  opts.onPhase?.('probes')
  const settings = {
    readOnly: opts.readOnly ?? false,
    anon: opts.roles?.anon ?? true,
    authenticated: opts.roles?.authenticated ?? true,
  }
  const probes = (
    await mapConcurrent(introspection.tables, TABLE_CONCURRENCY, (t) => runTableProbes(sql, t, actors, settings))
  ).flat()

  const totalsFor = (index: number): number | null => stats[index]?.total ?? null
  const totals = new Map(
    introspection.tables.map((t, index) => [tableKey(t.schema, t.table), totalsFor(index)]),
  )
  const findings = applyDeclaredExposure(
    mergeFindings(staticFindings, findingsFromProbes(probes, { introspection, totals })),
    introspection,
    opts.publicTables ?? [],
  )
  return {
    engineVersion: ENGINE_VERSION,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Date.now() - startedAtMs,
    // Only the host and database name: the driver's parsed options also hold the password.
    target: {
      host: sql.options.host.join(','),
      database: sql.options.database ?? '',
      schemas: [...schemas],
    },
    ...scoreFindings(findings),
    tables: introspection.tables.map((t, index) => toTableSummary(t, totalsFor(index))),
    findings,
    probes,
    actors,
    warnings: [...roleWarnings, ...unprobeableWarnings(introspection.tables)],
  }
}

export { buildIntrospection, detectOwnerColumn, findSensitiveColumns, introspect } from './introspect'
export { applyDeclaredExposure } from './declared'
export { findingsFromProbes, mergeFindings } from './dynamic'
export { gatherTableStats, runTableProbes } from './probes'
export { REPORT_VERSION, toReport } from './report'
export type { Report, ReportEvidence, ReportFinding, ReportSummary } from './report'
export { RULES, makeFinding } from './rules'
export type { FixHintContext, RuleDefinition, RuleId } from './rules'
export { SEVERITIES, meetsSeverity, scoreFindings } from './score'
export type { ScoreSummary } from './score'
export { runStaticRules, usesBareAuthUid } from './static'
export { ImpersonationError, impersonate, inRolledBackTx, stopImpersonating } from './tx'
export type { ProbeRole } from './tx'
export type * from './types'
