import {
  grantsApiAccess,
  quoteIdent,
  usesBareAuthUid,
  wrapBareAuthUid,
  type Introspection,
  type PolicyCommand,
  type PolicyInfo,
  type Report,
  type ReportFinding,
  type TableInfo,
} from '@redrow/engine'
import { sanitizeForTerminal } from '../sanitize'

export interface TemplateMigration {
  readonly text: string
  readonly statementCount: number
  /** Findings no template can safely fix, for a person to look at. */
  readonly manual: readonly string[]
}

interface Block {
  readonly rules: readonly string[]
  readonly label: string
  readonly statements: readonly string[]
}

interface TablePlan {
  readonly blocks: readonly Block[]
  readonly manual: readonly string[]
}

const RULE_ID = /^RR\d{3}$/
const OWNER_SCOPED = (column: string): RegExp =>
  new RegExp(
    `^\\(*"?${column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s*=\\s*(?:\\( SELECT auth\\.uid\\(\\) AS uid\\)|auth\\.uid\\(\\))\\)*$`,
  )

const relation = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`
const ownerCheck = (column: string): string => `${quoteIdent(column)} = (select auth.uid())`

/** Comments are one line, always: a newline in a name could otherwise end one and start SQL. */
const commentText = (text: string): string => sanitizeForTerminal(text)

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)]

const COMMANDS_FOR_RULE: Readonly<Record<string, readonly PolicyCommand[]>> = {
  RR101: ['SELECT'],
  RR102: ['SELECT'],
  RR103: ['UPDATE'],
  RR104: ['DELETE'],
  RR105: ['INSERT'],
}

const COMMAND_FOR_ANON_ACTION: Readonly<Record<string, PolicyCommand>> = {
  update_any: 'UPDATE',
  delete_any: 'DELETE',
  insert_other: 'INSERT',
}

function commandsFlaggedBy(finding: ReportFinding): readonly PolicyCommand[] {
  if (finding.id === 'RR106' && finding.evidence.kind === 'probe') {
    const command = COMMAND_FOR_ANON_ACTION[finding.evidence.action]
    return command === undefined ? [] : [command]
  }
  return COMMANDS_FOR_RULE[finding.id] ?? []
}

interface PolicyRewrite {
  readonly using?: string
  readonly check?: string
  readonly rules: readonly string[]
  readonly usesOwner: boolean
}

const SETS_USING: ReadonlySet<PolicyCommand> = new Set(['ALL', 'SELECT', 'UPDATE', 'DELETE'])
const SETS_CHECK: ReadonlySet<PolicyCommand> = new Set(['ALL', 'INSERT', 'UPDATE'])

function planPolicyRewrite(
  p: PolicyInfo,
  owner: string | undefined,
  findings: readonly ReportFinding[],
  scopeEveryPolicy: boolean,
): PolicyRewrite {
  const named = findings.filter((f) => f.policy === p.name)
  const flaggedByCommand = findings.filter((f) =>
    commandsFlaggedBy(f).some((command) => p.cmd === command || p.cmd === 'ALL'),
  )
  const namedRule = (id: string): boolean => named.some((f) => f.id === id)
  const scoped = owner === undefined ? () => false : (e: string | null) => e !== null && OWNER_SCOPED(owner).test(e)
  const wantsScope = scopeEveryPolicy || flaggedByCommand.length > 0 || namedRule('RR003')
  const wantsCheck = wantsScope || namedRule('RR004') || namedRule('RR005')

  const rewritesUsing = owner !== undefined && wantsScope && SETS_USING.has(p.cmd) && !scoped(p.qual)
  const rewritesCheck = owner !== undefined && wantsCheck && SETS_CHECK.has(p.cmd) && !scoped(p.withCheck)
  const bareUsing = !rewritesUsing && namedRule('RR008') && p.qual !== null && usesBareAuthUid(p.qual)
  const bareCheck = !rewritesCheck && namedRule('RR008') && p.withCheck !== null && usesBareAuthUid(p.withCheck)

  const using = rewritesUsing ? ownerCheck(owner) : bareUsing ? wrapBareAuthUid(p.qual as string) : undefined
  const check = rewritesCheck ? ownerCheck(owner) : bareCheck ? wrapBareAuthUid(p.withCheck as string) : undefined
  return {
    ...(using === undefined ? {} : { using }),
    ...(check === undefined ? {} : { check }),
    rules: unique([...flaggedByCommand, ...named].map((f) => f.id)),
    usesOwner: rewritesUsing || rewritesCheck,
  }
}

function policyStatement(p: PolicyInfo, t: TableInfo, rewrite: PolicyRewrite): string {
  const using = rewrite.using === undefined ? '' : ` using (${rewrite.using})`
  const check = rewrite.check === undefined ? '' : ` with check (${rewrite.check})`
  return `alter policy ${quoteIdent(p.name)} on ${relation(t.schema, t.table)}${using}${check}`
}

function planPolicies(
  t: TableInfo,
  policies: readonly PolicyInfo[],
  findings: readonly ReportFinding[],
  scopeEveryPolicy = false,
): { readonly blocks: readonly Block[]; readonly touchesOwner: boolean } {
  const blocks: Block[] = []
  let touchesOwner = false
  for (const p of policies.filter(grantsApiAccess)) {
    const rewrite = planPolicyRewrite(p, t.ownerColumn, findings, scopeEveryPolicy)
    if (rewrite.using === undefined && rewrite.check === undefined) continue
    touchesOwner ||= rewrite.usesOwner
    blocks.push({
      rules: rewrite.rules,
      label: `${t.schema}.${t.table}, policy ${p.name}`,
      statements: [policyStatement(p, t, rewrite)],
    })
  }
  return { blocks, touchesOwner }
}

/** RLS was off, so nothing protects this table yet. Every finding on it has the same cause. */
function planEnableRls(t: TableInfo, policies: readonly PolicyInfo[], findings: readonly ReportFinding[]): TablePlan {
  const rules = unique(findings.map((f) => f.id))
  const rel = relation(t.schema, t.table)
  const label = `${t.schema}.${t.table}`
  const enable = `alter table ${rel} enable row level security`
  if (t.ownerColumn === undefined) {
    return {
      blocks: [{ rules, label, statements: [enable, `revoke all on ${rel} from anon, authenticated`] }],
      manual: [`${rules.join(', ')} ${label}: no owner column, so this was locked down. Add the policies it needs.`],
    }
  }
  if (policies.length > 0) {
    // Policies that did nothing until now start to apply, so all of them get scoped.
    const planned = planPolicies(t, policies, findings, true)
    return {
      blocks: [
        { rules, label, statements: [enable] },
        ...planned.blocks.map((b) => ({ ...b, rules })),
        ...(planned.touchesOwner ? optionalIndexBlock(t) : []),
      ],
      manual: [],
    }
  }
  const check = ownerCheck(t.ownerColumn)
  return {
    blocks: [
      {
        rules,
        label,
        statements: [
          enable,
          `create policy "redrow_owner_access" on ${rel} for all to authenticated using (${check}) with check (${check})`,
        ],
      },
      ...optionalIndexBlock(t),
    ],
    manual: [],
  }
}

function planOwnerlessFindings(t: TableInfo, findings: readonly ReportFinding[]): TablePlan {
  const label = `${t.schema}.${t.table}`
  const rel = relation(t.schema, t.table)
  const anonWrites = findings.filter((f) => f.id === 'RR106')
  const rest = findings.filter((f) => !['RR106', 'RR008', 'RR009', 'RR010'].includes(f.id))
  return {
    blocks:
      anonWrites.length === 0
        ? []
        : [{ rules: ['RR106'], label, statements: [`revoke insert, update, delete on ${rel} from anon`] }],
    manual: rest.map((f) => `${f.id} ${label}: no owner column to scope this to, so it needs a person.`),
  }
}

/** An index on the owner column, unless it has one: a policy that scans the table would raise RR009. */
function optionalIndexBlock(t: TableInfo): readonly Block[] {
  const owner = t.ownerColumn
  if (owner === undefined || t.columns.some((c) => c.name === owner && c.indexed)) return []
  return [
    {
      rules: ['RR009'],
      label: `${t.schema}.${t.table}.${owner}`,
      statements: [
        `create index if not exists ${quoteIdent(`${t.table}_${owner}_idx`)} on ${relation(t.schema, t.table)} (${quoteIdent(owner)})`,
      ],
    },
  ]
}

function planRlsOnTable(
  t: TableInfo,
  policies: readonly PolicyInfo[],
  findings: readonly ReportFinding[],
  declared: boolean,
): TablePlan {
  const label = `${t.schema}.${t.table}`
  const rel = relation(t.schema, t.table)
  const blocks: Block[] = []
  const manual: string[] = []
  // Only if the catalog agrees: a report file is input, and this revoke would cut off a working table.
  if (findings.some((f) => f.id === 'RR010') && policies.length === 0) {
    blocks.push({ rules: ['RR010'], label, statements: [`revoke all on ${rel} from anon, authenticated`] })
    manual.push(`RR010 ${label}: revoked API access, which keeps today's behaviour. Add a policy if the API should reach it.`)
  }
  if (t.ownerColumn === undefined) {
    const ownerless = planOwnerlessFindings(t, findings)
    return { blocks: [...blocks, ...ownerless.blocks], manual: [...manual, ...ownerless.manual] }
  }
  // A declared table is meant to be readable, so scoping its reads could break the app.
  const writesOnly = declared ? findings.filter((f) => !['RR102', 'RR101', 'RR003'].includes(f.id)) : findings
  if (declared && writesOnly.length !== findings.length) {
    manual.push(`${label}: it's in publicTables, so its read policies were left alone. Check what signed-in users can read.`)
  }
  const planned = planPolicies(t, policies, writesOnly)
  blocks.push(...planned.blocks)
  const flagged = writesOnly.some((f) => f.id === 'RR009')
  const index = flagged || planned.touchesOwner ? optionalIndexBlock(t) : []
  return { blocks: [...blocks, ...index], manual }
}

function planView(report: readonly ReportFinding[], c: Introspection): Block[] {
  return report
    .filter((f) => f.id === 'RR006')
    .flatMap((f) => {
      const view = c.views.find((v) => v.schema === f.evidence.schema && v.view === f.table)
      if (view === undefined) return []
      const rel = relation(view.schema, view.view)
      return [
        {
          rules: ['RR006'],
          label: `${view.schema}.${view.view}`,
          statements: [
            view.materialized
              ? `revoke select on ${rel} from anon, authenticated`
              : `alter view ${rel} set (security_invoker = true)`,
          ],
        },
      ]
    })
}

function planFunctions(findings: readonly ReportFinding[], c: Introspection): Block[] {
  return findings
    .filter((f) => f.id === 'RR007')
    .flatMap((f) => {
      const fn = c.functions.find((candidate) =>
        f.description.startsWith(`${candidate.schema}.${candidate.name}(${candidate.args})`),
      )
      if (fn === undefined) return []
      return [
        {
          rules: ['RR007'],
          label: `${fn.schema}.${fn.name}(${fn.args})`,
          statements: [
            // All three: it skips RLS, so a signed-in user who could still call it bypasses the policies.
            `revoke execute on function ${relation(fn.schema, fn.name)}(${fn.args}) from anon, authenticated, public`,
          ],
        },
      ]
    })
}

function planTables(findings: readonly ReportFinding[], declaredTables: ReadonlySet<string>, c: Introspection): TablePlan {
  const onTables = findings.filter((f) => f.table !== null && !['RR006', 'RR007'].includes(f.id))
  const names = unique(onTables.map((f) => `${f.evidence.schema}\0${f.table}`))
  const plans = names.map((key): TablePlan => {
    const [schema, name] = key.split('\0') as [string, string]
    const own = onTables.filter((f) => f.evidence.schema === schema && f.table === name)
    const table = c.tables.find((t) => t.schema === schema && t.table === name)
    if (table === undefined) {
      return { blocks: [], manual: [`${unique(own.map((f) => f.id)).join(', ')} ${schema}.${name}: not found in the database.`] }
    }
    const policies = c.policies.filter((p) => p.schema === schema && p.table === name)
    return table.rlsEnabled
      ? planRlsOnTable(table, policies, own, declaredTables.has(key))
      : planEnableRls(table, policies, own)
  })
  return { blocks: plans.flatMap((p) => p.blocks), manual: plans.flatMap((p) => p.manual) }
}

function render(blocks: readonly Block[]): string {
  const body = blocks.map(
    (block) =>
      `-- ${unique(block.rules).sort().join(', ')}: ${commentText(block.label)}\n${block.statements.map((s) => `${s};`).join('\n')}`,
  )
  return ['-- Generated by redrow fix, from rule-based templates.', 'begin;', '', ...body.flatMap((b) => [b, '']), 'commit;', ''].join('\n')
}

/**
 * A migration built only from rule ids and the database's own catalog. Nothing from the
 * report file becomes SQL, so a crafted report can't write any.
 */
export function buildTemplateMigration(report: Report, catalog: Introspection): TemplateMigration {
  const actionable = report.findings.filter((f) => f.severity !== 'info' && RULE_ID.test(f.id))
  const declaredTables = new Set(
    report.findings.filter((f) => f.severity === 'info').map((f) => `${f.evidence.schema}\0${f.table}`),
  )
  const tables = planTables(actionable, declaredTables, catalog)
  const blocks = [...tables.blocks, ...planView(actionable, catalog), ...planFunctions(actionable, catalog)]
  return {
    text: render(blocks),
    statementCount: blocks.flatMap((b) => b.statements).length,
    manual: tables.manual.map(commentText),
  }
}
