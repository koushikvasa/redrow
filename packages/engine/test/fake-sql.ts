import type { Sql } from 'postgres'

export interface RecordedQuery {
  readonly text: string
  readonly values: readonly unknown[]
}

/** Rows for a query, or an Error to reject it with. `undefined` falls through to `rowsByQuery`. */
type Responder = (text: string, values: readonly unknown[]) => readonly object[] | Error | undefined

interface FakeOptions {
  /** Rows for a query, chosen by a substring of its text. Everything else returns no rows. */
  readonly rowsByQuery?: Readonly<Record<string, readonly object[]>>
  readonly respond?: Responder
  readonly host?: readonly string[]
  /** Every query rejects with this, as the driver does on a server error. */
  readonly failWith?: Error
}

export interface FakeSql {
  readonly client: Sql
  readonly queries: readonly RecordedQuery[]
  /** Transactions that ended in ROLLBACK and in COMMIT. COMMIT must always stay 0. */
  readonly transactions: { rolledBack: number; committed: number; modes: string[] }
}

const GENERATED_ID = '00000000-0000-4000-8000-0000000000ff'

const IDENTIFIER = Symbol('identifier')

interface Identifier {
  readonly [IDENTIFIER]: string
}

const isIdentifier = (value: unknown): value is Identifier =>
  typeof value === 'object' && value !== null && IDENTIFIER in value

/** `id` keeps query text readable, so tests can assert on it: `from "public"."t"`. */
function renderQuery(strings: TemplateStringsArray, values: readonly unknown[]): RecordedQuery {
  const text = strings.reduce((sofar, part, index) => {
    if (index === 0) return part
    const value = values[index - 1]
    return `${sofar}${isIdentifier(value) ? `"${value[IDENTIFIER]}"` : '?'}${part}`
  }, '')
  return { text, values: values.filter((value) => !isIdentifier(value)) }
}

/** Stands in for the driver: tagged template, `sql(name)`, `unsafe` and `begin`. Never touches a database. */
export function fakeSql({
  rowsByQuery = {},
  respond,
  host = ['db.test'],
  failWith,
}: FakeOptions = {}): FakeSql {
  const queries: RecordedQuery[] = []
  const transactions = { rolledBack: 0, committed: 0, modes: [] as string[] }

  const execute = (query: RecordedQuery): Promise<readonly object[]> => {
    queries.push(query)
    if (failWith !== undefined) return Promise.reject(failWith)
    const scripted = respond?.(query.text, query.values)
    if (scripted instanceof Error) return Promise.reject(scripted)
    const match = Object.keys(rowsByQuery).find((key) => query.text.includes(key))
    const generated = query.text.includes('gen_random_uuid') ? [{ id: GENERATED_ID }] : []
    const rows = scripted ?? (match === undefined ? generated : (rowsByQuery[match] ?? []))
    return Promise.resolve(Object.assign([...rows], { count: rows.length }))
  }

  // `.execute()` on a query is the driver's way of sending it now, and returns the same query.
  const tag = (first: TemplateStringsArray | string, ...values: unknown[]): unknown => {
    if (typeof first === 'string') return { [IDENTIFIER]: first }
    const pending = execute(renderQuery(first, values))
    return Object.assign(pending, { execute: () => pending })
  }

  const begin = async (mode: string, callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    transactions.modes.push(mode)
    try {
      const result = await callback(client)
      transactions.committed += 1
      return result
    } catch (error) {
      transactions.rolledBack += 1
      throw error
    }
  }

  // `pass` is here so a test can prove the report never picks it up.
  const client = Object.assign(tag, {
    options: { host: [...host], database: 'app_test', pass: 'hunter2-do-not-leak' },
    unsafe: (text: string) => execute({ text, values: [] }),
    begin,
  })
  return { client: client as unknown as Sql, queries, transactions }
}

/** A server error with a SQLSTATE, as the driver rejects with. */
export const serverError = (code: string, message = 'server error'): Error =>
  Object.assign(new Error(message), { code })
