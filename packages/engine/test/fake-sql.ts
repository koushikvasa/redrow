import type { Sql } from 'postgres'

export interface RecordedQuery {
  readonly text: string
  readonly values: readonly unknown[]
}

interface FakeOptions {
  /** Rows for a query, chosen by a substring of its text. Everything else returns no rows. */
  readonly rowsByQuery?: Readonly<Record<string, readonly object[]>>
  readonly host?: readonly string[]
  /** Every query rejects with this, as the driver does on a server error. */
  readonly failWith?: Error
}

export interface FakeSql {
  readonly client: Sql
  readonly queries: readonly RecordedQuery[]
}

/** Stands in for the driver's tagged template. Records queries; never touches a database. */
export function fakeSql({ rowsByQuery = {}, host = ['db.test'], failWith }: FakeOptions = {}): FakeSql {
  const queries: RecordedQuery[] = []
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<readonly object[]> => {
    const text = strings.join('?')
    queries.push({ text, values })
    if (failWith !== undefined) return Promise.reject(failWith)
    const match = Object.keys(rowsByQuery).find((key) => text.includes(key))
    return Promise.resolve(match === undefined ? [] : (rowsByQuery[match] ?? []))
  }
  // `pass` is here so a test can prove the report never picks it up.
  const client = Object.assign(tag, { options: { host: [...host], pass: 'hunter2-do-not-leak' } })
  return { client: client as unknown as Sql, queries }
}
