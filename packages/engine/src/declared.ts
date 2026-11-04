import type { Finding, Introspection, PolicyInfo, TableInfo, TablePrivileges } from './types'

const ROLES_ANON_ACTS_AS: ReadonlySet<string> = new Set(['anon', 'public'])

const REMEDIATION = 'None needed while this table is meant to be public. If it is not, remove it from publicTables.'

/** A bare name means the public schema only, so it can't reach `private.users` by accident. */
export const isDeclared = (table: TableInfo, publicTables: readonly string[]): boolean =>
  publicTables.includes(`${table.schema}.${table.table}`) ||
  (table.schema === 'public' && publicTables.includes(table.table))

const hasWriteGrant = (p: TablePrivileges): boolean => p.insert || p.update || p.delete

const appliesToAnon = (policy: PolicyInfo): boolean =>
  policy.roles.some((role) => ROLES_ANON_ACTS_AS.has(role))

const policiesOn = (table: TableInfo, policies: readonly PolicyInfo[]): readonly PolicyInfo[] =>
  policies.filter((p) => p.schema === table.schema && p.table === table.table)

/**
 * Whether the catalog shows a way to write. This reads no probe results on purpose: write
 * probes don't run under --read-only and can come back inconclusive, and "any write
 * exposure still counts" has to hold either way.
 */
function hasWriteExposure(table: TableInfo, policies: readonly PolicyInfo[]): boolean {
  // With RLS off, a grant works on every row, whoever holds it.
  if (!table.rlsEnabled) return hasWriteGrant(table.anon) || hasWriteGrant(table.authenticated)
  // With RLS on, Supabase's default grants mean nothing: only a policy lets anon write.
  return policies.some((p) => p.cmd !== 'SELECT' && p.permissive && appliesToAnon(p))
}

/** Which findings describe anon reading. Everything else keeps its severity and score. */
function isAnonRead(finding: Finding, policies: readonly PolicyInfo[]): boolean {
  switch (finding.ruleId) {
    case 'RR001':
    case 'RR101':
      return true
    case 'RR003':
      return (
        finding.probe === undefined &&
        policies.some((p) => p.name === finding.policy && p.cmd === 'SELECT' && appliesToAnon(p))
      )
    default:
      return false
  }
}

const sensitiveNote = (table: TableInfo): string =>
  table.sensitive.length === 0 ? '' : ` Sensitive columns: ${table.sensitive.join(', ')}.`

const withoutSensitiveNote = (detail: string): string => detail.replace(/ Sensitive columns: .*$/, '')

/**
 * Tables the project means to expose, listed in `publicTables` by name or `schema.table`.
 * Anon reading one is reported at `info`, which scores nothing. It stays in the report, so
 * the exposure is declared rather than hidden. RR102 goes away on a table in
 * `noWiderThanAnon`, keyed by `schema.table`, where a signed-in user sees nothing beyond
 * what RR101 already reports. A table anyone can write to gets no such treatment, even
 * for its reads.
 */
export function applyDeclaredExposure(
  findings: readonly Finding[],
  introspection: Introspection,
  publicTables: readonly string[],
  noWiderThanAnon: ReadonlySet<string> = new Set(),
): Finding[] {
  return findings.flatMap((finding) => {
    const table = introspection.tables.find((t) => t.schema === finding.schema && t.table === finding.table)
    if (table === undefined || !isDeclared(table, publicTables)) return [finding]
    const policies = policiesOn(table, introspection.policies)
    if (hasWriteExposure(table, policies)) return [finding]
    if (finding.ruleId === 'RR102' && noWiderThanAnon.has(`${table.schema}.${table.table}`)) return []
    if (!isAnonRead(finding, policies)) return [finding]
    return [
      {
        ...finding,
        severity: 'info',
        title: 'Declared exposure',
        detail: `Declared exposure: ${withoutSensitiveNote(finding.detail)}${sensitiveNote(table)}`,
        fixHint: REMEDIATION,
      },
    ]
  })
}
