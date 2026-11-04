import type { Sql, TransactionSql } from 'postgres'

export type ProbeRole = 'anon' | 'authenticated'

const PROBE_ROLES: ReadonlySet<string> = new Set<ProbeRole>(['anon', 'authenticated'])

const SQLSTATE = /^[0-9A-Z]{5}$/

class RollbackSignal extends Error {}

/**
 * The connecting role can't become an API role. This must fail the scan: read as a denied
 * probe, it would make every table look safe. It has no `code`, so nothing treats it as a
 * server response to a probe.
 */
export class ImpersonationError extends Error {}

/**
 * The transaction never got as far as running a probe: the login failed, or the pooler
 * refused. It keeps the server's `code` for the CLI's messages, but it is not an answer
 * from any policy, even when the code looks like one.
 */
export class TxSetupError extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

// Connection, login, resource and shutdown errors say nothing about the statement that was
// running, so they are never a probe's answer. `57014`, a timeout, is about the statement.
const NOT_ABOUT_THE_STATEMENT = /^(08|28|53|57P)/

/**
 * The SQLSTATE of an error that is the database's answer to a statement. Everything else
 * returns undefined, so that callers let it fail the scan instead of reading it as a result.
 */
export function sqlStateOf(error: unknown): string | undefined {
  if (error instanceof TxSetupError) return undefined
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const { code } = error
  return typeof code === 'string' && SQLSTATE.test(code) && !NOT_ABOUT_THE_STATEMENT.test(code) ? code : undefined
}

function asSetupError(error: unknown): unknown {
  const hasServerCode =
    error instanceof Error && 'code' in error && typeof error.code === 'string' && SQLSTATE.test(error.code)
  return hasServerCode ? new TxSetupError(error.message, error.code as string) : error
}

export interface TxOptions {
  /** Have the database itself refuse writes, not just skip sending them. */
  readonly readOnly?: boolean
}

/**
 * Runs `fn` in a transaction that always ends in ROLLBACK: throwing is the only way
 * out of the callback, so no path through here can commit. `sql.begin` holds one
 * connection for the transaction and releases it on success and on failure.
 *
 * Repeatable read keeps before and after counts comparable: another session's commit
 * can't shift them, while this transaction still sees its own writes.
 */
export async function inRolledBackTx<T>(
  sql: Sql,
  fn: (tx: TransactionSql) => Promise<T>,
  { readOnly = false }: TxOptions = {},
): Promise<T> {
  const mode = `isolation level repeatable read${readOnly ? ' read only' : ''}`
  let out: T | undefined
  let isSetUp = false
  try {
    await sql.begin(mode, async (tx) => {
      await tx`set local statement_timeout = '5s'`
      await tx`set local lock_timeout = '1s'`
      isSetUp = true
      out = await fn(tx)
      throw new RollbackSignal()
    })
  } catch (error: unknown) {
    if (error instanceof RollbackSignal) return out as T
    throw isSetUp ? error : asSetupError(error)
  }
  // Unreachable: the callback always throws. Kept so that a driver change can't fall through silently.
  throw new Error('The probe transaction ended without rolling back')
}

async function switchRole(tx: TransactionSql, role: ProbeRole): Promise<void> {
  try {
    // The role can't be a bind parameter. It is safe to inline because the caller checked it.
    await tx.unsafe(`set local role ${role}`)
  } catch (error: unknown) {
    if (sqlStateOf(error) === undefined) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new ImpersonationError(
      `The connecting role can't act as ${role}: ${reason}. Connect as the postgres role.`,
    )
  }
}

/**
 * Become an API caller for the rest of the transaction. Everything here is
 * transaction-local: `set_config(..., true)` is the parameterized form of SET LOCAL.
 * Both claim forms are set because `auth.uid()` reads either, depending on its version.
 */
export async function impersonate(tx: TransactionSql, role: ProbeRole, sub?: string): Promise<void> {
  if (!PROBE_ROLES.has(role)) {
    throw new Error(`Refusing to impersonate role outside the whitelist: ${role}`)
  }
  const claims = JSON.stringify(sub === undefined ? { role } : { sub, role })
  await switchRole(tx, role)
  await tx`select set_config('request.jwt.claims', ${claims}, true),
                  set_config('request.jwt.claim.sub', ${sub ?? ''}, true),
                  set_config('request.jwt.claim.role', ${role}, true)`
}

/** Back to the connecting role, to measure a probe's effect within the same transaction. */
export async function stopImpersonating(tx: TransactionSql): Promise<void> {
  await tx.unsafe('set local role none')
}
