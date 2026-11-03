import type { Finding, Severity } from './types'

/** Names a fix hint can refer to. Hints fall back to placeholders for anything absent. */
export interface FixHintContext {
  readonly schema: string
  readonly table?: string
  readonly column?: string
  readonly policy?: string
  /** RR006: a materialized view can't take `security_invoker`, so its fix differs. */
  readonly materialized?: boolean
  /** RR007: the function's name and identity arguments. */
  readonly functionName?: string
  readonly functionArgs?: string
}

export interface RuleDefinition {
  readonly severity: Severity
  readonly title: string
  readonly fixHint: (context: FixHintContext) => string
}

// Hints are meant to be pasted, so every identifier is quoted: that keeps them
// valid for mixed-case and reserved names such as Prisma's "User" or "order".
const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

const relation = (c: FixHintContext): string =>
  `${quoteIdent(c.schema)}.${c.table === undefined ? '<table>' : quoteIdent(c.table)}`

const ownerCheck = (c: FixHintContext): string =>
  `${c.column === undefined ? '<owner_column>' : quoteIdent(c.column)} = (select auth.uid())`

const policyName = (c: FixHintContext): string =>
  c.policy === undefined ? '<policy>' : quoteIdent(c.policy)

const enableRlsWithOwnerPolicy = (c: FixHintContext): string =>
  `alter table ${relation(c)} enable row level security; ` +
  `create policy "owner_access" on ${relation(c)} for all to authenticated ` +
  `using (${ownerCheck(c)}) with check (${ownerCheck(c)});`

const scopeReadsToOwner = (c: FixHintContext): string =>
  `create policy "owner_read" on ${relation(c)} for select to authenticated using (${ownerCheck(c)}); ` +
  `-- then drop any policy that uses "true" or a role-only check for reads`

const scopeWritesToOwner = (c: FixHintContext): string =>
  `Limit ${relation(c)} write policies to the owner: using (${ownerCheck(c)}) with check (${ownerCheck(c)}).`

const revokeAnonWrites = (c: FixHintContext): string =>
  `revoke insert, update, delete on ${relation(c)} from anon;`

export const RULES = {
  RR001: {
    severity: 'critical',
    title: 'RLS disabled: table is publicly readable through the API',
    fixHint: enableRlsWithOwnerPolicy,
  },
  RR002: {
    severity: 'high',
    title: 'RLS disabled on a table API roles can access',
    fixHint: enableRlsWithOwnerPolicy,
  },
  RR003: {
    severity: 'high',
    title: 'Read policy matches every row (USING true)',
    fixHint: (c) => `alter policy ${policyName(c)} on ${relation(c)} using (${ownerCheck(c)});`,
  },
  RR004: {
    severity: 'medium',
    title: 'UPDATE policy has no explicit WITH CHECK',
    fixHint: (c) => `alter policy ${policyName(c)} on ${relation(c)} with check (${ownerCheck(c)});`,
  },
  RR005: {
    severity: 'medium',
    title: 'INSERT policy does not check row ownership',
    fixHint: (c) => `alter policy ${policyName(c)} on ${relation(c)} with check (${ownerCheck(c)});`,
  },
  RR006: {
    severity: 'high',
    title: 'View bypasses RLS',
    fixHint: (c) =>
      c.materialized === true
        ? `revoke select on ${relation(c)} from anon, authenticated;`
        : `alter view ${relation(c)} set (security_invoker = true);`,
  },
  RR007: {
    severity: 'high',
    title: 'SECURITY DEFINER function callable from the API',
    fixHint: (c) =>
      `revoke execute on function ${quoteIdent(c.schema)}.` +
      `${c.functionName === undefined ? '<function>' : quoteIdent(c.functionName)}(${c.functionArgs ?? ''}) ` +
      `from public, anon, authenticated; -- then grant it only to the roles that need it, or make it security invoker`,
  },
  RR008: {
    severity: 'low',
    title: 'Policy re-evaluates auth.uid() for every row',
    fixHint: (c) =>
      `In policy ${policyName(c)} on ${relation(c)}, replace auth.uid() with (select auth.uid()) so it is evaluated once per query.`,
  },
  RR009: {
    severity: 'low',
    title: 'Owner column used in a policy has no index',
    fixHint: (c) =>
      `create index on ${relation(c)} (${c.column === undefined ? '<owner_column>' : quoteIdent(c.column)});`,
  },
  RR010: {
    severity: 'medium',
    title: 'RLS enabled with no policies, so API roles see nothing',
    fixHint: (c) =>
      `revoke all on ${relation(c)} from anon, authenticated; ` +
      `-- if only the service role should reach this table; otherwise add an owner-scoped policy instead`,
  },
  RR101: {
    severity: 'critical',
    title: 'Anonymous users can read an owned or sensitive table',
    fixHint: enableRlsWithOwnerPolicy,
  },
  RR102: {
    severity: 'critical',
    title: "A signed-in user can read other users' rows",
    fixHint: scopeReadsToOwner,
  },
  RR103: {
    severity: 'critical',
    title: "A signed-in user can update other users' rows",
    fixHint: scopeWritesToOwner,
  },
  RR104: {
    severity: 'critical',
    title: "A signed-in user can delete other users' rows",
    fixHint: scopeWritesToOwner,
  },
  RR105: {
    severity: 'high',
    title: 'A signed-in user can insert a row owned by someone else',
    fixHint: scopeWritesToOwner,
  },
  RR106: {
    severity: 'high',
    title: 'Anonymous users can write to a table',
    fixHint: revokeAnonWrites,
  },
} as const satisfies Record<string, RuleDefinition>

export type RuleId = keyof typeof RULES

/** Builds a finding from the catalog. `severity` overrides the default where a rule has two levels. */
export function makeFinding(
  ruleId: RuleId,
  context: FixHintContext,
  detail: string,
  severity?: Severity,
): Finding {
  const rule: RuleDefinition = RULES[ruleId]
  return {
    ruleId,
    severity: severity ?? rule.severity,
    schema: context.schema,
    ...(context.table === undefined ? {} : { table: context.table }),
    title: rule.title,
    detail,
    fixHint: rule.fixHint(context),
  }
}
