import type { ISql } from 'postgres'
import type {
  ColumnInfo,
  Introspection,
  PolicyCommand,
  PolicyInfo,
  SecurityDefinerFunction,
  TableInfo,
  TablePrivileges,
  ViewInfo,
} from './types'

// Order matters: when a table has several candidates, the earlier name wins.
const OWNER_COLUMN_NAMES = [
  'user_id',
  'owner_id',
  'created_by',
  'author_id',
  'profile_id',
  'clinician_id',
  'account_id',
] as const

const SENSITIVE_NAME_PARTS = [
  'email',
  'phone',
  'dob',
  'birth',
  'ssn',
  'address',
  'diagnosis',
  'note',
  'medical',
  'salary',
  'token',
  'secret',
  'password',
  'card',
  'iban',
] as const

export interface TableRow {
  readonly schema: string
  readonly table: string
  readonly oid: number
  readonly rls_enabled: boolean
  readonly rls_forced: boolean
  readonly anon_select: boolean
  readonly anon_insert: boolean
  readonly anon_update: boolean
  readonly anon_delete: boolean
  readonly auth_select: boolean
  readonly auth_insert: boolean
  readonly auth_update: boolean
  readonly auth_delete: boolean
}

export interface ColumnRow {
  readonly table_oid: number
  readonly attnum: number
  readonly column: string
  readonly type: string
}

export interface PolicyRow {
  readonly schema: string
  readonly table: string
  readonly name: string
  readonly permissive: string
  readonly roles: readonly string[]
  readonly cmd: PolicyCommand
  readonly qual: string | null
  readonly with_check: string | null
}

export interface ViewRow {
  readonly schema: string
  readonly view: string
  readonly relkind: string
  readonly security_invoker: boolean
  readonly anon_select: boolean
  readonly auth_select: boolean
}

export interface FunctionRow {
  readonly schema: string
  readonly name: string
  readonly args: string
  readonly anon_exec: boolean
  readonly auth_exec: boolean
}

export interface AuthUserFkRow {
  readonly table_oid: number
  readonly column: string
  /** The column is the table's whole primary key, as with `profiles.id`. */
  readonly is_sole_pk: boolean
}

export interface IndexRow {
  readonly table_oid: number
  readonly attnum: number
}

export interface CatalogRows {
  readonly tables: readonly TableRow[]
  readonly columns: readonly ColumnRow[]
  readonly policies: readonly PolicyRow[]
  readonly views: readonly ViewRow[]
  readonly functions: readonly FunctionRow[]
  readonly authUserFks: readonly AuthUserFkRow[]
  readonly indexes: readonly IndexRow[]
}

/** Reads the system catalogs only. Nothing here touches a user table. */
export async function fetchCatalog(sql: ISql, schemaNames: readonly string[]): Promise<CatalogRows> {
  const schemas = [...schemaNames]
  const [tables, columns, policies, views, functions, authUserFks, indexes] = await Promise.all([
    sql<TableRow[]>`
      select n.nspname as schema, c.relname as table, c.oid,
             c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
             has_table_privilege('anon', c.oid, 'SELECT')          as anon_select,
             has_table_privilege('anon', c.oid, 'INSERT')          as anon_insert,
             has_table_privilege('anon', c.oid, 'UPDATE')          as anon_update,
             has_table_privilege('anon', c.oid, 'DELETE')          as anon_delete,
             has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
             has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
             has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
             has_table_privilege('authenticated', c.oid, 'DELETE') as auth_delete
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r','p') and n.nspname = any(${schemas}::text[])
      order by 1, 2`,
    sql<ColumnRow[]>`
      select c.oid as table_oid, a.attnum, a.attname as column, format_type(a.atttypid, a.atttypmod) as type
      from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${schemas}::text[]) and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
      order by 1, 2`,
    sql<PolicyRow[]>`
      select schemaname as schema, tablename as table, policyname as name, permissive,
             roles::text[] as roles, cmd, qual, with_check
      from pg_policies where schemaname = any(${schemas}::text[])
      order by 1, 2, 3`,
    sql<ViewRow[]>`
      select n.nspname as schema, c.relname as view, c.relkind,
             exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
                     where o in ('security_invoker=true','security_invoker=on','security_invoker=1')) as security_invoker,
             has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
             has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('v','m') and n.nspname = any(${schemas}::text[])
      order by 1, 2`,
    sql<FunctionRow[]>`
      select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname = any(${schemas}::text[])
      order by 1, 2, 3`,
    sql<AuthUserFkRow[]>`
      select con.conrelid as table_oid, a.attname as column,
             exists (select 1 from pg_constraint pk
                     where pk.conrelid = con.conrelid and pk.contype = 'p'
                       and pk.conkey = array[a.attnum]) as is_sole_pk
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
      where con.contype = 'f' and con.confrelid = 'auth.users'::regclass`,
    // One query for every leading index column, rather than one round trip per column.
    sql<IndexRow[]>`
      select i.indrelid as table_oid, i.indkey[0] as attnum
      from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any(${schemas}::text[])`,
  ])
  return { tables, columns, policies, views, functions, authUserFks, indexes }
}

/**
 * Owner detection, after config: FK to auth.users, then name heuristic. A primary key
 * that is itself such an FK wins among FKs: the table is 1:1 with users (`profiles.id`),
 * so another column such as `created_by` can't be the owner.
 */
export function detectOwnerColumn(
  columns: readonly ColumnInfo[],
  authUserFks: readonly AuthUserFkRow[],
): string | undefined {
  const fkColumns = new Set(authUserFks.map((fk) => fk.column))
  return (
    authUserFks.find((fk) => fk.is_sole_pk)?.column ??
    pickOwnerCandidate(columns.filter((c) => fkColumns.has(c.name))) ??
    pickNamedOwner(columns.filter((c) => c.type === 'uuid'))
  )
}

function pickNamedOwner(columns: readonly ColumnInfo[]): string | undefined {
  return OWNER_COLUMN_NAMES.find((name) => columns.some((c) => c.name === name))
}

function pickOwnerCandidate(candidates: readonly ColumnInfo[]): string | undefined {
  return pickNamedOwner(candidates) ?? candidates[0]?.name
}

export function findSensitiveColumns(columnNames: readonly string[]): string[] {
  return columnNames.filter((name) => {
    const lower = name.toLowerCase()
    return SENSITIVE_NAME_PARTS.some((part) => lower.includes(part))
  })
}

function configuredOwnerColumn(
  row: TableRow,
  columns: readonly ColumnInfo[],
  ownerColumns: Readonly<Record<string, string>>,
): string | undefined {
  if (!Object.hasOwn(ownerColumns, row.table)) return undefined
  const configured = ownerColumns[row.table]
  if (!columns.some((c) => c.name === configured)) {
    throw new Error(
      `ownerColumns: ${row.schema}.${row.table} has no column "${configured}". Check redrow.config.json.`,
    )
  }
  return configured
}

function toTableInfo(
  row: TableRow,
  rows: CatalogRows,
  ownerColumns: Readonly<Record<string, string>>,
): TableInfo {
  const indexedAttnums = new Set(
    rows.indexes.filter((i) => i.table_oid === row.oid).map((i) => i.attnum),
  )
  const columns: ColumnInfo[] = rows.columns
    .filter((c) => c.table_oid === row.oid)
    .map((c) => ({
      attnum: c.attnum,
      name: c.column,
      type: c.type,
      indexed: indexedAttnums.has(c.attnum),
    }))
  const fks = rows.authUserFks.filter((fk) => fk.table_oid === row.oid)
  const ownerColumn =
    configuredOwnerColumn(row, columns, ownerColumns) ?? detectOwnerColumn(columns, fks)
  const anon: TablePrivileges = {
    select: row.anon_select,
    insert: row.anon_insert,
    update: row.anon_update,
    delete: row.anon_delete,
  }
  const authenticated: TablePrivileges = {
    select: row.auth_select,
    insert: row.auth_insert,
    update: row.auth_update,
    delete: row.auth_delete,
  }
  return {
    oid: row.oid,
    schema: row.schema,
    table: row.table,
    rlsEnabled: row.rls_enabled,
    rlsForced: row.rls_forced,
    anon,
    authenticated,
    columns,
    ...(ownerColumn === undefined ? {} : { ownerColumn }),
    sensitive: findSensitiveColumns(columns.map((c) => c.name)),
  }
}

const toPolicyInfo = (row: PolicyRow): PolicyInfo => ({
  schema: row.schema,
  table: row.table,
  name: row.name,
  permissive: row.permissive === 'PERMISSIVE',
  roles: row.roles,
  cmd: row.cmd,
  qual: row.qual,
  withCheck: row.with_check,
})

const toViewInfo = (row: ViewRow): ViewInfo => ({
  schema: row.schema,
  view: row.view,
  materialized: row.relkind === 'm',
  securityInvoker: row.security_invoker,
  anonSelect: row.anon_select,
  authSelect: row.auth_select,
})

const toFunctionInfo = (row: FunctionRow): SecurityDefinerFunction => ({
  schema: row.schema,
  name: row.name,
  args: row.args,
  anonExec: row.anon_exec,
  authExec: row.auth_exec,
})

/** Turns raw catalog rows into the domain model. Pure, so it can be tested without a database. */
export function buildIntrospection(
  rows: CatalogRows,
  ownerColumns: Readonly<Record<string, string>> = {},
): Introspection {
  return {
    tables: rows.tables.map((row) => toTableInfo(row, rows, ownerColumns)),
    policies: rows.policies.map(toPolicyInfo),
    views: rows.views.map(toViewInfo),
    functions: rows.functions.map(toFunctionInfo),
  }
}

// What the catalog queries raise when `auth.users` or the `anon` / `authenticated` roles are absent.
const MISSING_SUPABASE_OBJECT_CODES: ReadonlySet<string> = new Set([
  '42P01', // undefined_table
  '3F000', // invalid_schema_name
  '42704', // undefined_object: a role that does not exist
])

function hasMissingObjectCode(error: unknown): error is Error {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    MISSING_SUPABASE_OBJECT_CODES.has(error.code)
  )
}

export async function introspect(
  sql: ISql,
  schemas: readonly string[],
  ownerColumns: Readonly<Record<string, string>> = {},
): Promise<Introspection> {
  try {
    return buildIntrospection(await fetchCatalog(sql, schemas), ownerColumns)
  } catch (error: unknown) {
    if (!hasMissingObjectCode(error)) throw error
    throw new Error(
      `This doesn't look like a Supabase database: ${error.message}. ` +
        'Red Row needs the auth.users table and the anon and authenticated roles.',
      { cause: error },
    )
  }
}
