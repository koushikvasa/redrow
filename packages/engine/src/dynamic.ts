import { makeFinding, type RuleId } from './rules'
import { grantsApiAccess } from './static'
import type {
  Finding,
  Introspection,
  PolicyCommand,
  ProbeAction,
  ProbeResult,
  TableInfo,
} from './types'

export interface ProbeContext {
  readonly introspection: Introspection
  /** Row totals, keyed by `schema.table`. */
  readonly totals: ReadonlyMap<string, number | null>
}

export const tableKey = (schema: string, table: string): string => `${schema}.${table}`

const rowsOf = (n: number): string => `${n} ${n === 1 ? 'row' : 'rows'}`

const COMMAND_FOR_ACTION: Readonly<Record<ProbeAction, PolicyCommand>> = {
  select_own: 'SELECT',
  select_others: 'SELECT',
  select_all: 'SELECT',
  insert_other: 'INSERT',
  update_other: 'UPDATE',
  delete_other: 'DELETE',
  update_any: 'UPDATE',
  delete_any: 'DELETE',
}

function policyNames(table: TableInfo, action: ProbeAction, introspection: Introspection): string | undefined {
  if (!table.rlsEnabled) return undefined
  const command = COMMAND_FOR_ACTION[action]
  const names = introspection.policies
    .filter(
      (p) =>
        p.schema === table.schema &&
        p.table === table.table &&
        (p.cmd === command || p.cmd === 'ALL') &&
        grantsApiAccess(p),
    )
    .map((p) => p.name)
  return names.length === 0 ? undefined : names.join(', ')
}

interface Classified {
  readonly ruleId: RuleId
  readonly detail: string
}

function classifyAnonProbe(probe: ProbeResult, table: TableInfo, name: string): Classified | undefined {
  const rows = rowsOf(probe.rowCount ?? 0)
  switch (probe.action) {
    case 'select_all':
      return table.ownerColumn === undefined && table.sensitive.length === 0
        ? undefined
        : { ruleId: 'RR101', detail: `Anyone holding the public anon key can read ${rows} of ${name} through the API.` }
    case 'update_any':
      return { ruleId: 'RR106', detail: `Anyone holding the public anon key can update ${rows} of ${name}.` }
    case 'delete_any':
      return { ruleId: 'RR106', detail: `Anyone holding the public anon key can delete ${rows} of ${name}.` }
    case 'insert_other':
      return { ruleId: 'RR106', detail: `Anyone holding the public anon key can insert rows into ${name}.` }
    default:
      return undefined
  }
}

function classifyUserSelectAll(
  probe: ProbeResult,
  table: TableInfo,
  name: string,
  total: number | null | undefined,
): Classified | undefined {
  if (!table.rlsEnabled || table.sensitive.length === 0 || probe.rowCount !== total) return undefined
  return {
    ruleId: 'RR003',
    detail: `Every signed-in user can read all ${rowsOf(probe.rowCount ?? 0)} of ${name}, which has sensitive columns: ${table.sensitive.join(', ')}.`,
  }
}

function classifyUserProbe(
  probe: ProbeResult,
  table: TableInfo,
  name: string,
  total: number | null | undefined,
): Classified | undefined {
  const rows = rowsOf(probe.rowCount ?? 0)
  switch (probe.action) {
    case 'select_others':
      return { ruleId: 'RR102', detail: `A signed-in user can read ${rows} of ${name} owned by other users.` }
    case 'update_other':
      return { ruleId: 'RR103', detail: `A signed-in user can change ${rows} of ${name} owned by other users.` }
    case 'delete_other':
      return { ruleId: 'RR104', detail: `A signed-in user can delete ${rows} of ${name} owned by other users.` }
    case 'insert_other':
      return {
        ruleId: 'RR105',
        detail:
          probe.rowCount === null
            ? `A signed-in user can create rows in ${name} owned by someone else: RLS let the test row through and only a later constraint rejected it, so a complete row would succeed.`
            : `A signed-in user can insert a row into ${name} owned by someone else.`,
      }
    case 'select_all':
      return classifyUserSelectAll(probe, table, name, total)
    default:
      return undefined
  }
}

/** RR101-RR106, plus RR003's evidence on un-owned tables. Pure, so testable without a database. */
export function findingsFromProbes(probes: readonly ProbeResult[], context: ProbeContext): Finding[] {
  return probes.flatMap((probe) => {
    const table = context.introspection.tables.find(
      (t) => t.schema === probe.schema && t.table === probe.table,
    )
    if (table === undefined || probe.outcome !== 'allowed') return []
    const key = tableKey(probe.schema, probe.table)
    const classified =
      probe.actor === 'anon'
        ? classifyAnonProbe(probe, table, key)
        : classifyUserProbe(probe, table, key, context.totals.get(key))
    if (classified === undefined) return []
    const policy = policyNames(table, probe.action, context.introspection)
    return [
      {
        ...makeFinding(
          classified.ruleId,
          {
            schema: table.schema,
            table: table.table,
            ...(table.ownerColumn === undefined ? {} : { column: table.ownerColumn }),
            ...(policy === undefined ? {} : { policy }),
          },
          classified.detail,
        ),
        ...(probe.rowCount === null ? {} : { rowsExposed: probe.rowCount }),
        probe: { actor: probe.actor, action: probe.action, outcome: probe.outcome, rowCount: probe.rowCount },
      },
    ]
  })
}

const sameTable = (a: Finding, b: Finding): boolean => a.schema === b.schema && a.table === b.table

/**
 * Dynamic proof wins (ENGINE.md §2): RR102 replaces a static RR003 on the same table
 * and keeps its text as the explanation. A dynamic RR003 adds nothing to a static one.
 */
export function mergeFindings(
  staticFindings: readonly Finding[],
  dynamicFindings: readonly Finding[],
): Finding[] {
  const openReads = staticFindings.filter((f) => f.ruleId === 'RR003')
  const proven = dynamicFindings
    .filter((f) => f.ruleId !== 'RR003' || !openReads.some((s) => sameTable(s, f)))
    .map((finding) => {
      if (finding.ruleId !== 'RR102') return finding
      const causes = openReads.filter((s) => sameTable(s, finding))
      if (causes.length === 0) return finding
      const policy = causes.flatMap((c) => (c.policy === undefined ? [] : [c.policy])).join(', ')
      return {
        ...finding,
        detail: `${finding.detail} Cause: ${causes.map((c) => c.detail).join(' ')}`,
        ...(policy === '' ? {} : { policy }),
      }
    })
  const suppressed = dynamicFindings.filter((f) => f.ruleId === 'RR102')
  return [
    ...staticFindings.filter(
      (f) => f.ruleId !== 'RR003' || !suppressed.some((proof) => sameTable(proof, f)),
    ),
    ...proven,
  ]
}
