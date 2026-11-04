import type { Introspection, Report } from '@redrow/engine'
import { MigrationError, statementTarget } from './migration'

const QUALIFIED_NAME = /^("(?:[^"]|"")+"|[^\s".]+)\s*\.\s*("(?:[^"]|"")+"|[^\s".]+)$/

const MAX_IDENTIFIER_BYTES = 63

/** Postgres silently cuts a longer name, on a character boundary, so "abc…zzz" can mean "abc…". */
function truncateIdentifier(name: string): string {
  let bytes = 0
  let kept = ''
  for (const character of name) {
    bytes += Buffer.byteLength(character)
    if (bytes > MAX_IDENTIFIER_BYTES) break
    kept += character
  }
  return kept
}

/** A name as Postgres resolves it: quoted is exact, unquoted folds to lower case. */
const resolveIdentifier = (identifier: string): string =>
  truncateIdentifier(identifier.startsWith('"') ? identifier.slice(1, -1).replace(/""/g, '"') : identifier.toLowerCase())

const key = (schema: string, name: string): string => `${schema}\0${name}`

/** Everything the report found a problem with. Declared (info) findings aren't problems. */
function reportedObjects(report: Report, catalog: Introspection): ReadonlySet<string> {
  const findings = report.findings.filter((f) => f.severity !== 'info')
  const relations = findings.flatMap((f) => (f.table === null ? [] : [key(f.evidence.schema, f.table)]))
  const functions = catalog.functions
    .filter((fn) =>
      findings.some((f) => f.id === 'RR007' && f.description.startsWith(`${fn.schema}.${fn.name}(${fn.args})`)),
    )
    .map((fn) => key(fn.schema, fn.name))
  return new Set([...relations, ...functions])
}

function assertStatementInScope(statement: string, objects: ReadonlySet<string>, catalog: Introspection): void {
  const target = statementTarget(statement)
  const parts = target === undefined ? null : QUALIFIED_NAME.exec(target.relation)
  if (target === undefined || parts === null) {
    throw new MigrationError(`Name the schema of every object: ${statement.slice(0, 120)}`)
  }
  const schema = resolveIdentifier(parts[1] as string)
  const name = resolveIdentifier(parts[2] as string)
  if (!objects.has(key(schema, name))) {
    throw new MigrationError(`The report found nothing wrong with ${schema}.${name}, so a fix may not change it.`)
  }
  if (target.existingPolicy === undefined) return
  const policyName = resolveIdentifier(target.existingPolicy)
  const isRestrictive = catalog.policies.some(
    (p) => p.schema === schema && p.table === name && p.name === policyName && !p.permissive,
  )
  if (isRestrictive) {
    throw new MigrationError(`${policyName} on ${schema}.${name} is a restrictive policy, and a fix may not loosen one.`)
  }
}

/**
 * For SQL written by a model. The parser checks what kind of statement this is; this checks
 * what it touches, so a prompt injected through a table name can't reach anything else.
 */
export function assertInScope(statements: readonly string[], report: Report, catalog: Introspection): void {
  const objects = reportedObjects(report, catalog)
  for (const statement of statements) assertStatementInScope(statement, objects, catalog)
}
