import { makeFinding, type FixHintContext } from './rules'
import type {
  Finding,
  Introspection,
  PolicyInfo,
  SecurityDefinerFunction,
  TableInfo,
  TablePrivileges,
  ViewInfo,
} from './types'

type TableRule = (table: TableInfo, policies: readonly PolicyInfo[]) => readonly Finding[]

// A policy for any other role can't affect API callers. In particular `service_role`
// has BYPASSRLS, so `to service_role using (true)` is harmless and must not be flagged.
const API_ROLES: ReadonlySet<string> = new Set(['public', 'anon', 'authenticated'])

const appliesToApi = (policy: PolicyInfo): boolean => policy.roles.some((role) => API_ROLES.has(role))

/** Only a permissive policy can widen access; a restrictive one can only narrow it. */
export const grantsApiAccess = (policy: PolicyInfo): boolean =>
  policy.permissive && appliesToApi(policy)

const hasAnyPrivilege = (p: TablePrivileges): boolean => p.select || p.insert || p.update || p.delete

const isAlwaysTrue = (expression: string | null): boolean =>
  expression !== null && expression.replace(/[()\s]/g, '').toLowerCase() === 'true'

const qualifiedName = (table: TableInfo): string => `${table.schema}.${table.table}`

const tableContext = (table: TableInfo, policy?: PolicyInfo): FixHintContext => ({
  schema: table.schema,
  table: table.table,
  ...(table.ownerColumn === undefined ? {} : { column: table.ownerColumn }),
  ...(policy === undefined ? {} : { policy: policy.name }),
})

const sensitiveSuffix = (table: TableInfo): string =>
  table.sensitive.length === 0 ? '' : ` Sensitive columns: ${table.sensitive.join(', ')}.`

const checkRlsDisabled: TableRule = (table) => {
  if (table.rlsEnabled) return []
  if (table.anon.select) {
    return [
      makeFinding(
        'RR001',
        tableContext(table),
        `RLS is off and anon can SELECT ${qualifiedName(table)}, so anyone holding the public anon key can read it through the API.${sensitiveSuffix(table)}`,
      ),
    ]
  }
  // Not publicly readable, but anon may still hold write grants: those count here too.
  const holders = [
    hasAnyPrivilege(table.anon) ? 'anon' : null,
    hasAnyPrivilege(table.authenticated) ? 'authenticated' : null,
  ].filter((role) => role !== null)
  if (holders.length === 0) return []
  return [
    makeFinding(
      'RR002',
      tableContext(table),
      `RLS is off on ${qualifiedName(table)}, so ${holders.join(' and ')} can use every privilege they hold on every row.${sensitiveSuffix(table)}`,
    ),
  ]
}

const checkOpenReadPolicies: TableRule = (table, policies) => {
  if (table.ownerColumn === undefined && table.sensitive.length === 0) return []
  return policies
    .filter((p) => (p.cmd === 'SELECT' || p.cmd === 'ALL') && grantsApiAccess(p) && isAlwaysTrue(p.qual))
    .map((p) =>
      makeFinding(
        'RR003',
        tableContext(table, p),
        `Policy "${p.name}" on ${qualifiedName(table)} has USING (true), so every member of ${p.roles.join(', ')} can read every row.${sensitiveSuffix(table)}`,
      ),
    )
}

const checkMissingWithCheck: TableRule = (table, policies) =>
  policies
    .filter(
      (p) =>
        (p.cmd === 'UPDATE' || p.cmd === 'ALL') &&
        grantsApiAccess(p) &&
        p.qual !== null &&
        p.withCheck === null,
    )
    .map((p) =>
      makeFinding(
        'RR004',
        tableContext(table, p),
        `Policy "${p.name}" on ${qualifiedName(table)} has no WITH CHECK, so Postgres reuses USING to check new rows. Rows can only be re-owned if USING is not owner-scoped; an explicit WITH CHECK states the rule either way.`,
      ),
    )

const checkOpenInsertPolicies: TableRule = (table, policies) => {
  if (table.ownerColumn === undefined) return []
  return policies
    .filter(
      (p) =>
        p.cmd === 'INSERT' && grantsApiAccess(p) && (p.withCheck === null || isAlwaysTrue(p.withCheck)),
    )
    .map((p) =>
      makeFinding(
        'RR005',
        tableContext(table, p),
        p.withCheck === null
          ? `INSERT policy "${p.name}" on ${qualifiedName(table)} has no WITH CHECK, which Postgres treats as deny: it denies every insert, which is probably not what was intended.`
          : `INSERT policy "${p.name}" on ${qualifiedName(table)} has WITH CHECK (true), so a signed-in user can insert a row with any owner in ${table.ownerColumn}.`,
      ),
    )
}

const checkNoPolicies: TableRule = (table, policies) => {
  const hasApiPrivileges = hasAnyPrivilege(table.anon) || hasAnyPrivilege(table.authenticated)
  if (!table.rlsEnabled || policies.length > 0 || !hasApiPrivileges) return []
  return [
    makeFinding(
      'RR010',
      tableContext(table),
      `RLS is on with no policies on ${qualifiedName(table)}, so API roles get no rows despite holding privileges. This is usually a missing policy.`,
    ),
  ]
}

// Matches `( SELECT auth.uid() AS uid)` and a cast inside it, `( SELECT (auth.uid())::text AS uid)`.
const WRAPPED_AUTH_UID = /\(\s*SELECT\s+\(?\s*auth\.uid\(\)\s*\)?(?:::\w+)?(?:\s+AS\s+\w+)?\s*\)/gi

/** True when an expression calls `auth.uid()` outside a `(select ...)`, so it runs once per row. */
export function usesBareAuthUid(expression: string): boolean {
  return /auth\.uid\(\)/i.test(expression.replace(WRAPPED_AUTH_UID, ''))
}

/** Rewrites each bare `auth.uid()` to the wrapped form, leaving ones already wrapped alone. */
export function wrapBareAuthUid(expression: string): string {
  const eitherForm = new RegExp(`${WRAPPED_AUTH_UID.source}|auth\\.uid\\(\\)`, 'gi')
  return expression.replace(eitherForm, (match) =>
    match.toLowerCase() === 'auth.uid()' ? '( SELECT auth.uid() AS uid)' : match,
  )
}

const policyExpressions = (policy: PolicyInfo): string[] =>
  [policy.qual, policy.withCheck].filter((e): e is string => e !== null)

const checkBareAuthUid: TableRule = (table, policies) =>
  policies
    .filter((p) => appliesToApi(p) && policyExpressions(p).some(usesBareAuthUid))
    .map((p) =>
      makeFinding(
        'RR008',
        tableContext(table, p),
        `Policy "${p.name}" on ${qualifiedName(table)} calls auth.uid() directly, so it is re-evaluated for every row scanned.`,
      ),
    )

const referencesColumn = (expression: string, column: string): boolean => {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(expression)
}

const checkUnindexedOwnerColumn: TableRule = (table, policies) => {
  const owner = table.ownerColumn
  if (owner === undefined || table.columns.some((c) => c.name === owner && c.indexed)) return []
  const usedInPolicy = policies.some(
    (p) => appliesToApi(p) && policyExpressions(p).some((e) => referencesColumn(e, owner)),
  )
  if (!usedInPolicy) return []
  return [
    makeFinding(
      'RR009',
      tableContext(table),
      `${qualifiedName(table)}.${owner} is used in a policy but no index leads with it, so each query scans the table.`,
    ),
  ]
}

const TABLE_RULES: readonly TableRule[] = [
  checkRlsDisabled,
  checkOpenReadPolicies,
  checkMissingWithCheck,
  checkOpenInsertPolicies,
  checkBareAuthUid,
  checkUnindexedOwnerColumn,
  checkNoPolicies,
]

function checkView(view: ViewInfo): readonly Finding[] {
  if (view.securityInvoker || (!view.anonSelect && !view.authSelect)) return []
  const roles = [view.anonSelect ? 'anon' : null, view.authSelect ? 'authenticated' : null]
    .filter((role) => role !== null)
    .join(', ')
  const reason = view.materialized
    ? 'Materialized views never respect RLS'
    : 'Without security_invoker this view runs with its owner\'s rights and ignores the caller\'s RLS'
  return [
    makeFinding(
      'RR006',
      { schema: view.schema, table: view.view, materialized: view.materialized },
      `${reason}, and ${roles} can select from ${view.schema}.${view.view}.`,
    ),
  ]
}

function checkDefinerFunction(fn: SecurityDefinerFunction): readonly Finding[] {
  if (!fn.anonExec && !fn.authExec) return []
  const callers = fn.anonExec ? 'anon' : 'authenticated'
  return [
    makeFinding(
      'RR007',
      { schema: fn.schema, functionName: fn.name, functionArgs: fn.args },
      `${fn.schema}.${fn.name}(${fn.args}) runs with its owner's rights, skipping RLS, and ${callers} can call it through the API.`,
      fn.anonExec ? 'high' : 'medium',
    ),
  ]
}

/** RR001-RR010, as pure functions over the introspection result. */
export function runStaticRules(introspection: Introspection): Finding[] {
  const tableFindings = introspection.tables.flatMap((table) => {
    const policies = introspection.policies.filter(
      (p) => p.schema === table.schema && p.table === table.table,
    )
    return TABLE_RULES.flatMap((rule) => rule(table, policies))
  })
  return [
    ...tableFindings,
    ...introspection.views.flatMap(checkView),
    ...introspection.functions.flatMap(checkDefinerFunction),
  ]
}
