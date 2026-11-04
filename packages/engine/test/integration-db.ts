import postgres, { type Sql } from 'postgres'

export const TEST_DB_URL = process.env.REDROW_TEST_DB_URL

const NOT_SET = 'REDROW_TEST_DB_URL is not set.'

const isLocal = (url: string): boolean => /@(localhost|127\.0\.0\.1)[:/]/.test(url)

/** A new client, so a new connection: what it sees is what really persisted. */
export function connectToTestDb(max = 1): Sql {
  if (TEST_DB_URL === undefined) throw new Error(NOT_SET)
  return postgres(TEST_DB_URL, {
    max,
    onnotice: () => {},
    ssl: isLocal(TEST_DB_URL) ? false : 'require',
    prepare: false,
  })
}

/** The same database as a different login, to test what a limited role can and can't do. */
export function connectToTestDbAs(username: string, password: string): Sql {
  if (TEST_DB_URL === undefined) throw new Error(NOT_SET)
  const url = new URL(TEST_DB_URL)
  url.username = username
  url.password = password
  return postgres(url.toString(), {
    max: 2,
    onnotice: () => {},
    ssl: isLocal(TEST_DB_URL) ? false : 'require',
    prepare: false,
  })
}

export interface SessionState {
  readonly role: string
  readonly claims: string | null
  readonly sub: string | null
}

/** The session state that impersonation changes. All of it must be back to default afterwards. */
export async function readSessionState(sql: Sql): Promise<SessionState> {
  const rows = await sql<SessionState[]>`
    select current_user::text as role,
           nullif(current_setting('request.jwt.claims', true), '') as claims,
           nullif(current_setting('request.jwt.claim.sub', true), '') as sub`
  return rows[0] as SessionState
}
