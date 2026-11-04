import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { CliError } from './errors'

export const DEFAULT_CONFIG_FILE = 'redrow.config.json'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// JSON has no comments, so the starter config explains itself with `$comment` keys.
const comment = z.string().optional()

const userId = z.string().regex(UUID, 'must be a uuid').nullable().default(null)

// Rejecting these outright, rather than ignoring them, means a pattern someone hoped would
// work fails loudly. Matching is exact, so `*.supabase.com` could only ever match nothing.
const exactHostName = z
  .string()
  .regex(
    /^[A-Za-z0-9.-]+(\/[A-Za-z0-9._-]+)?$/,
    'must be one exact host, or host/login, with no wildcard, port or scheme',
  )

// Only the dashboard reads these. They're checked here so a typo fails where it's made.
const personaSchema = z.strictObject({
  anon: z.string().min(1),
  anonShort: z.string().min(1),
  loggedIn: z.string().min(1),
  userA: z.string().min(1),
  userAOwn: z.string().min(1),
  others: z.string().min(1),
  tables: z
    .record(
      z.string(),
      z.strictObject({
        noun: z.string().min(1),
        strangerNoun: z.string().min(1).optional(),
        strangerReadNoun: z.string().min(1).optional(),
      }),
    )
    .default({}),
})

const configSchema = z.strictObject({
  $comment: comment,
  schemas: z.array(z.string().min(1)).min(1).default(['public']),
  tables: z.array(z.string().min(1)).default([]),
  roles: z
    .strictObject({
      $comment: comment,
      anon: z.boolean().default(true),
      authenticated: z.boolean().default(true),
      service_role: z
        .literal(false, { error: 'service_role bypasses RLS, so probing it proves nothing. Leave it false.' })
        .default(false),
    })
    .prefault({}),
  tenants: z
    .strictObject({ $comment: comment, userA: userId, userB: userId })
    .prefault({})
    .refine(({ userA, userB }) => (userA === null) === (userB === null), {
      error: 'set both userA and userB, or neither',
    })
    .refine(({ userA, userB }) => userA === null || userA.toLowerCase() !== userB?.toLowerCase(), {
      error: 'userA and userB must be different users, or a cross-tenant leak cannot show up',
    }),
  ownerColumns: z.record(z.string(), z.string().min(1)).default({}),
  allowHosts: z.array(exactHostName).default([]),
  publicTables: z.array(z.string().min(1)).default([]),
  personas: z.record(z.string(), personaSchema).optional(),
  // By project, like personas: one config can cover databases with different users.
  actors: z.record(z.string(), z.strictObject({ userA: z.email() })).default({}),
})

export interface RedrowConfig {
  readonly schemas: readonly string[]
  readonly tables: readonly string[]
  readonly roles: { readonly anon: boolean; readonly authenticated: boolean; readonly service_role: false }
  readonly tenants: { readonly userA: string | null; readonly userB: string | null }
  readonly ownerColumns: Readonly<Record<string, string>>
  readonly allowHosts: readonly string[]
  readonly publicTables: readonly string[]
  /** By project name: the auth.users email to pin as user A. `tenants` wins over this. */
  readonly actors: Readonly<Record<string, { readonly userA: string }>>
}

export const STARTER_CONFIG = `${JSON.stringify(
  {
    $comment:
      'Red Row config. Keys named $comment are ignored, because JSON has no comments. ' +
      'allowHosts: what to scan without -y, as an exact host, or host/login; no wildcards. Supabase projects share a pooler host, so use host/login there. ' +
      'publicTables: tables anon is meant to read; a bare name means the public schema, or use schema.table. Their anon reads are reported as declared exposure and score nothing, and writes still count.',
    schemas: ['public'],
    tables: [],
    roles: {
      $comment:
        'Which API roles to impersonate. service_role must stay false: it bypasses RLS, so probing it proves nothing.',
      anon: true,
      authenticated: true,
      service_role: false,
    },
    tenants: {
      $comment:
        'Two user ids in different tenants, used to probe cross-tenant leakage. Set both, or leave both null to pick two owners from the data.',
      userA: null,
      userB: null,
    },
    ownerColumns: {},
    allowHosts: [],
    publicTables: [],
  },
  null,
  2,
)}\n`

/** Validates parsed JSON. `source` names the file in error messages. */
export function parseConfig(raw: unknown, source: string): RedrowConfig {
  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const path = issue.path.join('.')
      return `  ${path === '' ? '(top level)' : path}: ${issue.message}`
    })
    throw new CliError(`Invalid config in ${source}:\n${problems.join('\n')}`)
  }
  const { schemas, tables, roles, tenants, ownerColumns, allowHosts, publicTables, actors } = result.data
  return {
    schemas,
    tables,
    roles: { anon: roles.anon, authenticated: roles.authenticated, service_role: roles.service_role },
    tenants: { userA: tenants.userA, userB: tenants.userB },
    ownerColumns,
    allowHosts,
    publicTables,
    actors,
  }
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw new CliError(`${label} is not valid JSON: ${error.message}`)
    throw new CliError(`Could not read config file ${label}`)
  }
}

/** An explicit path must exist. The default file is optional. */
export function loadConfig(path: string | undefined, cwd: string): RedrowConfig {
  const label = path ?? DEFAULT_CONFIG_FILE
  const resolved = resolve(cwd, label)
  if (path === undefined && !existsSync(resolved)) return parseConfig({}, 'defaults')
  return parseConfig(readJson(resolved, label), label)
}
