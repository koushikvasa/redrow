import postgres, { type Sql } from 'postgres'
import { CliError } from './errors'

export const PRODUCTION_OVERRIDE_FLAG = '--i-know-what-im-doing'

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const SAFE_DATABASE_NAME = /test|demo|staging/i

// Everything else is refused: the driver lets the query string override the host, database
// and server settings, so allowing it would let the guard judge one target and connect to
// another. `pgbouncer` is ignored; Supabase pooler strings often carry it for Prisma.
const ALLOWED_QUERY_PARAMS: ReadonlySet<string> = new Set(['sslmode', 'pgbouncer'])

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
])

const MAX_CONNECTIONS = 5
const CONNECT_TIMEOUT_SECONDS = 10
const DEFAULT_PORT = 5432

export type SslSetting = false | 'require' | 'verify-full'

export interface ConnectionTarget {
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly password: string
  readonly isLocal: boolean
  /** Safe to print: no user name or password. */
  readonly label: string
  /** The password, raw and decoded, so it can be scrubbed from any message. */
  readonly secrets: readonly string[]
  readonly ssl: SslSetting
}

export interface Connection {
  readonly sql: Sql
  readonly end: () => Promise<void>
}

const INVALID_URL =
  'That is not a valid Postgres connection string. Expected postgresql://user:password@host:5432/database. ' +
  'If the password has special characters such as / ? # or @, URL-encode them.'

function parseUrl(url: string): URL {
  try {
    return new URL(url)
  } catch {
    throw new CliError(INVALID_URL)
  }
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    throw new CliError(INVALID_URL)
  }
}

function resolveSsl(sslMode: string | null, isLocal: boolean): SslSetting {
  if (sslMode === 'verify-full' || sslMode === 'verify-ca') return 'verify-full'
  if (isLocal) return sslMode === 'require' ? 'require' : false
  if (sslMode === 'disable') {
    throw new CliError(
      'Refusing sslmode=disable on a remote host: the password would be sent in the clear. Remove it, or use sslmode=require.',
    )
  }
  // Never let a remote password travel in the clear, so `prefer` and `allow` become `require`.
  return 'require'
}

// The url is left out of every error here: if it failed to parse, a password may be in it.
export function parseConnection(url: string): ConnectionTarget {
  const parsed = parseUrl(url)
  const host = parsed.hostname
  const database = decode(parsed.pathname.slice(1))
  const isWellFormed =
    /^postgres(ql)?:$/.test(parsed.protocol) &&
    host !== '' &&
    !host.includes(',') &&
    database !== '' &&
    parsed.hash === ''
  if (!isWellFormed) throw new CliError(INVALID_URL)
  const hasOnlyAllowedParams = [...parsed.searchParams.keys()].every((key) => ALLOWED_QUERY_PARAMS.has(key))
  if (!hasOnlyAllowedParams) {
    throw new CliError(
      'Only sslmode and pgbouncer are allowed in the connection string query, because other parameters can change which server and database are used.',
    )
  }
  const isLocal = LOCAL_HOSTS.has(host)
  return {
    host,
    port: parsed.port === '' ? DEFAULT_PORT : Number(parsed.port),
    database,
    username: decode(parsed.username),
    password: decode(parsed.password),
    isLocal,
    label: `${host}/${database}`,
    secrets: [parsed.password, decode(parsed.password)].filter((secret) => secret !== ''),
    ssl: resolveSsl(parsed.searchParams.get('sslmode'), isLocal),
  }
}

export const needsProductionOverride = (target: ConnectionTarget): boolean =>
  !target.isLocal && !SAFE_DATABASE_NAME.test(target.database)

/**
 * Exact comparison only: no suffixes, patterns or parent domains. An entry is a host, or
 * host/login. Every Supabase project in a region shares a pooler host and differs only
 * by login, so there the login is what actually names the project.
 */
export const isAllowedHost = (target: ConnectionTarget, allowHosts: readonly string[]): boolean =>
  allowHosts.includes(target.host) || allowHosts.includes(`${target.host}/${target.username}`)

export function assertAllowedTarget(
  target: ConnectionTarget,
  overridden: boolean,
  allowHosts: readonly string[],
): void {
  if (!needsProductionOverride(target) || overridden || isAllowedHost(target, allowHosts)) return
  throw new CliError(
    `Refusing to scan ${target.label}: this looks like production.\n` +
      `The host isn't localhost and the database name doesn't contain test, demo or staging.\n` +
      `Row changes are always rolled back, but a rollback can't undo everything: triggers fire, sequences\n` +
      `advance, and extensions such as dblink or http can have outside effects. Unfiltered updates and\n` +
      `deletes also add load, for up to 5 seconds per statement.\n` +
      `Supabase databases are always named "postgres". To scan this one on purpose, add -y (${PRODUCTION_OVERRIDE_FLAG}),\n` +
      `or list this exact host, or host/login for a shared pooler, in allowHosts in redrow.config.json.`,
  )
}

/**
 * Hands the driver the same fields the guard judged, never the url, so the two can't
 * disagree about where this connects. Explicit fields also shut out PGHOST and friends.
 */
export function openConnection(target: ConnectionTarget): Connection {
  const sql = postgres({
    host: target.host.replace(/^\[|\]$/g, ''),
    port: target.port,
    database: target.database,
    username: target.username,
    password: target.password,
    ssl: target.ssl,
    max: MAX_CONNECTIONS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: 5,
    // Prepared statements don't survive Supabase's transaction pooler.
    prepare: false,
    onnotice: () => {},
  })
  return { sql, end: () => sql.end({ timeout: 5 }) }
}

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined

const scrub = (message: string, target: ConnectionTarget): string =>
  target.secrets.reduce((text, secret) => text.split(secret).join('***'), message)

/** A message fit to show: the Supabase gotchas get advice, and everything else loses any password. */
export function describeDbError(error: unknown, target: ConnectionTarget): string {
  const code = codeOf(error)
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
    return (
      `Could not connect to ${target.label} (${code}).\n` +
      `On Supabase, the direct database host is IPv6-only. Use the Session pooler connection string ` +
      `(port 5432) from your project's Connect dialog.`
    )
  }
  if (code === '28P01' || code === '28000') {
    return `Authentication failed for ${target.label}. Check the password in your connection string.`
  }
  if (code === '3D000') return `Database "${target.database}" does not exist on ${target.host}.`
  return scrub(error instanceof Error ? error.message : String(error), target)
}
