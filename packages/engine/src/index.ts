import type { Sql } from 'postgres'
import { introspect } from './introspect'
import { scoreFindings } from './score'
import { runStaticRules } from './static'
import type { ScanOptions, ScanResult, TableInfo, TableSummary } from './types'

export const ENGINE_VERSION = '0.1.0'

const DEFAULT_SCHEMAS: readonly string[] = ['public']

const toTableSummary = (table: TableInfo): TableSummary => ({
  schema: table.schema,
  table: table.table,
  rlsEnabled: table.rlsEnabled,
  ...(table.ownerColumn === undefined ? {} : { ownerColumn: table.ownerColumn }),
  // Counted by the probe phase, which doesn't exist yet: see HANDOVER.md H2.
  totalRows: 0,
  sensitive: table.sensitive,
})

/** Introspect, apply static rules, score. Dynamic probes join this pipeline in H2. */
export async function scan(sql: Sql, opts: ScanOptions = {}): Promise<ScanResult> {
  const schemas = opts.schemas ?? DEFAULT_SCHEMAS
  if (schemas.length === 0) {
    throw new Error('scan: at least one schema is required')
  }
  const startedAtMs = Date.now()
  const introspection = await introspect(sql, schemas, opts.ownerColumns)
  const findings = runStaticRules(introspection)
  return {
    engineVersion: ENGINE_VERSION,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Date.now() - startedAtMs,
    // Only the host: the driver's parsed options also hold the password, which must never be reported.
    target: { host: sql.options.host.join(','), schemas: [...schemas] },
    ...scoreFindings(findings),
    tables: introspection.tables.map(toTableSummary),
    findings,
    probes: [],
    actors: { userA: '', userB: '' },
  }
}

export { buildIntrospection, detectOwnerColumn, findSensitiveColumns, introspect } from './introspect'
export { RULES, makeFinding } from './rules'
export type { FixHintContext, RuleDefinition, RuleId } from './rules'
export { scoreFindings } from './score'
export type { ScoreSummary } from './score'
export { runStaticRules, usesBareAuthUid } from './static'
export type * from './types'
