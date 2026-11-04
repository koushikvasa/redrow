import { sanitizeForTerminal } from '../sanitize'

export class MigrationError extends Error {}

export interface SplitStatement {
  readonly sql: string
  readonly comments: readonly string[]
}

export interface Migration {
  /** What gets written to the file, rebuilt from the statements: it can't differ from what was checked. */
  readonly text: string
  /** What gets executed, one at a time: begin and commit are never sent. */
  readonly statements: readonly string[]
}

export interface StatementTarget {
  /** The relation or function, as written: unquoted or quoted, with or without a schema. */
  readonly relation: string
  /** Set on alter policy and drop policy, which can loosen an existing policy. */
  readonly existingPolicy?: string
}

// Postgres counts every non-ASCII character as an identifier character.
const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-￿]/
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/

function endOfSingleQuoted(text: string, start: number): number {
  const prefix = text[start - 1]
  const isEscapeString = (prefix === 'E' || prefix === 'e') && !IDENTIFIER_CHAR.test(text[start - 2] ?? '')
  for (let i = start + 1; i < text.length; i += 1) {
    if (isEscapeString && text[i] === '\\') i += 1
    else if (text[i] === "'" && text[i + 1] === "'") i += 1
    else if (text[i] === "'") return i
  }
  throw new MigrationError('Unterminated string in the migration')
}

function endOfDoubleQuoted(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '"' && text[i + 1] === '"') i += 1
    else if (text[i] === '"') return i
  }
  throw new MigrationError('Unterminated quoted identifier in the migration')
}

function endOfDollarQuoted(text: string, start: number, tag: string): number {
  const end = text.indexOf(tag, start + tag.length)
  if (end === -1) throw new MigrationError('Unterminated dollar quote in the migration')
  return end + tag.length - 1
}

function endOfBlockComment(text: string, start: number): number {
  let depth = 1
  for (let i = start + 2; i < text.length; i += 1) {
    if (text.startsWith('/*', i)) {
      depth += 1
      i += 1
    } else if (text.startsWith('*/', i)) {
      depth -= 1
      i += 1
      if (depth === 0) return i
    }
  }
  throw new MigrationError('Unterminated comment in the migration')
}

const dollarTagAt = (text: string, i: number): string | undefined =>
  IDENTIFIER_CHAR.test(text[i - 1] ?? '') ? undefined : DOLLAR_TAG.exec(text.slice(i))?.[0]

/** Postgres ends a line comment at either a newline or a carriage return. */
function endOfLineComment(text: string, start: number): number {
  const end = text.slice(start).search(/[\r\n]/)
  return end === -1 ? text.length : start + end
}

/**
 * Splits SQL into statements the way Postgres reads it, so that a `;` inside a string,
 * identifier, dollar quote or comment can't hide or invent a statement. A comment becomes
 * a space, as it does for Postgres, so one can't join two words into something harmless.
 */
export function splitStatements(text: string): SplitStatement[] {
  const statements: SplitStatement[] = []
  let sql = ''
  let comments: string[] = []
  const flush = (): void => {
    if (sql.trim() !== '') {
      statements.push({ sql: sql.trim(), comments })
      comments = []
    }
    sql = ''
  }
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string
    const tag = char === '$' ? dollarTagAt(text, i) : undefined
    if (text.startsWith('--', i)) {
      const end = endOfLineComment(text, i)
      comments.push(text.slice(i + 2, end).trim())
      sql += ' '
      i = end
    } else if (text.startsWith('/*', i)) {
      const end = endOfBlockComment(text, i)
      comments.push(text.slice(i + 2, end - 1).trim())
      sql += ' '
      i = end
    } else if (char === ';') {
      flush()
    } else if (char === "'" || char === '"' || tag !== undefined) {
      const end =
        tag !== undefined
          ? endOfDollarQuoted(text, i, tag)
          : char === "'"
            ? endOfSingleQuoted(text, i)
            : endOfDoubleQuoted(text, i)
      sql += text.slice(i, end + 1)
      i = end
    } else {
      sql += char
    }
  }
  flush()
  return statements
}

const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)'
const REL = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`
const PRIVILEGE = '(?:select|insert|update|delete|truncate|references|trigger|execute|usage)'
const PRIVILEGES = `(?:all(?:\\s+privileges)?|${PRIVILEGE}(?:\\s*,\\s*${PRIVILEGE})*)`
const IDENT_LIST = `${IDENT}(?:\\s*,\\s*${IDENT})*`
const TARGET = `(?<relation>${REL})`
const EXISTING_POLICY = `(?<existingPolicy>${IDENT})`

/**
 * Everything a fix may do. This is an allowlist because the SQL can come from a model, and
 * names in the prompt can be written by anyone who can create a table. Each pattern also
 * rules out the dangerous variants of its statement:
 * - `cascade`, which can drop what depends on an object.
 * - A policy for any role but authenticated. With no TO clause, it applies to PUBLIC.
 * - An index on anything but plain columns. An expression or predicate is evaluated per row
 *   during validation, so it could run a function or put a row's value in an error message.
 *   That rule is what keeps row data out of the retry prompt: nothing else here reads rows.
 */
const ALLOWED_STATEMENTS: readonly RegExp[] = [
  new RegExp(`^alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${TARGET}\\s+(?:enable|force)\\s+row\\s+level\\s+security$`, 'i'),
  new RegExp(
    `^create\\s+policy\\s+${IDENT}\\s+on\\s+${TARGET}\\s+(?:as\\s+(?:permissive|restrictive)\\s+)?` +
      `(?:for\\s+(?:all|select|insert|update|delete)\\s+)?to\\s+authenticated\\s+(?:using|with\\s+check)\\s*\\([\\s\\S]*\\)$`,
    'i',
  ),
  new RegExp(`^alter\\s+policy\\s+${EXISTING_POLICY}\\s+on\\s+${TARGET}\\s+(?:using|with\\s+check)\\s*\\([\\s\\S]*\\)$`, 'i'),
  new RegExp(`^drop\\s+policy\\s+(?:if\\s+exists\\s+)?${EXISTING_POLICY}\\s+on\\s+${TARGET}$`, 'i'),
  new RegExp(`^alter\\s+view\\s+(?:if\\s+exists\\s+)?${TARGET}\\s+set\\s*\\(\\s*security_invoker\\s*=\\s*(?:true|on)\\s*\\)$`, 'i'),
  new RegExp(
    `^create\\s+index\\s+(?:if\\s+not\\s+exists\\s+)?(?:(?!concurrently\\b)${IDENT}\\s+)?on\\s+(?:only\\s+)?${TARGET}\\s*\\(\\s*${IDENT_LIST}\\s*\\)$`,
    'i',
  ),
  // [^()]: one function per statement. A wider match would let a list hide others from the scope check.
  new RegExp(`^revoke\\s+${PRIVILEGES}\\s+on\\s+function\\s+${TARGET}\\s*\\([^()]*\\)\\s+from\\s+${IDENT_LIST}$`, 'i'),
  new RegExp(`^revoke\\s+${PRIVILEGES}\\s+on\\s+(?:table\\s+)?${TARGET}\\s+from\\s+${IDENT_LIST}$`, 'i'),
]

// A policy that is literally true is the bug being fixed. Subtler ones are the rescan's job.
const OPEN_EXPRESSION = /\b(?:using|with\s+check)\s*\(\s*(?:\(\s*)*true\s*(?:\)\s*)*\)/i

const QUOTED_TEXT = /"(?:[^"]|"")*"|'(?:[^']|'')*'/g

const isAllowed = (sql: string): boolean =>
  !OPEN_EXPRESSION.test(sql.replace(QUOTED_TEXT, '""')) && ALLOWED_STATEMENTS.some((pattern) => pattern.test(sql))

/** What an allowed statement changes, for checking it against what the report found. */
export function statementTarget(sql: string): StatementTarget | undefined {
  for (const pattern of ALLOWED_STATEMENTS) {
    const groups = pattern.exec(sql)?.groups
    if (groups?.relation !== undefined) {
      return {
        relation: groups.relation,
        ...(groups.existingPolicy === undefined ? {} : { existingPolicy: groups.existingPolicy }),
      }
    }
  }
  return undefined
}

const RULE_ID = /\bRR\d{3}\b/

// Only when it wraps the whole reply: templates hold catalog strings and never come through here.
const WHOLE_REPLY_FENCE = /^```(?:sql)?[ \t]*\r?\n([\s\S]*)```$/i

function renderStatement(statement: SplitStatement): string {
  const comments = statement.comments.map((comment) => `-- ${sanitizeForTerminal(comment)}`)
  return [...comments, `${statement.sql};`].join('\n')
}

/** The file holds what was parsed, not the input, so it can't differ from what gets checked. */
const renderMigration = (statements: readonly SplitStatement[]): string =>
  `${statements.map((s, i) => `${i > 0 && s.comments.length > 0 ? '\n' : ''}${renderStatement(s)}`).join('\n')}\n`

function assertBlocksNameTheirRules(body: readonly SplitStatement[]): void {
  const first = body[0] as SplitStatement
  if (!first.comments.some((comment) => RULE_ID.test(comment))) {
    throw new MigrationError(`The first block needs a comment naming its rule id, such as -- RR003: ${first.sql.slice(0, 60)}`)
  }
}

/**
 * Checks a migration before anything runs it, and returns it as separate statements. It
 * must be begin, then allowed schema changes each under a rule-id comment, then commit.
 */
export function parseMigration(text: string): Migration {
  const parsed = splitStatements(text)
  const first = parsed[0]?.sql.toLowerCase()
  const last = parsed.at(-1)?.sql.toLowerCase()
  if (parsed.length < 3 || first !== 'begin' || last !== 'commit') {
    throw new MigrationError('The migration must start with begin; and end with commit;, with statements between them.')
  }
  const body = parsed.slice(1, -1)
  const rejected = body.find((statement) => !isAllowed(statement.sql))
  if (rejected !== undefined) {
    throw new MigrationError(`This statement is not allowed in a fix: ${rejected.sql.slice(0, 120)}`)
  }
  assertBlocksNameTheirRules(body)
  return { text: renderMigration(parsed), statements: body.map((statement) => statement.sql) }
}

/** Parses a model's reply, which often comes wrapped in a code fence. */
export function parseModelOutput(reply: string): Migration {
  const trimmed = reply.trim()
  return parseMigration(WHOLE_REPLY_FENCE.exec(trimmed)?.[1] ?? trimmed)
}
