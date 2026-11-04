import type {
  ColumnInfo,
  Introspection,
  PolicyInfo,
  SecurityDefinerFunction,
  TableInfo,
  TablePrivileges,
  ViewInfo,
} from '../src/types'

export const ALL_PRIVILEGES: TablePrivileges = { select: true, insert: true, update: true, delete: true }
export const NO_PRIVILEGES: TablePrivileges = { select: false, insert: false, update: false, delete: false }
export const SELECT_ONLY: TablePrivileges = { ...NO_PRIVILEGES, select: true }

export const column = (name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo => ({
  attnum: 1,
  name,
  type: 'uuid',
  indexed: false,
  writable: true,
  ...overrides,
})

/** An RLS-enabled table with Supabase's default grants and no owner or sensitive columns. */
export const table = (name: string, overrides: Partial<TableInfo> = {}): TableInfo => ({
  oid: 1,
  schema: 'public',
  table: name,
  rlsEnabled: true,
  rlsForced: false,
  anon: ALL_PRIVILEGES,
  authenticated: ALL_PRIVILEGES,
  columns: [],
  sensitive: [],
  ...overrides,
})

export const policy = (tableName: string, overrides: Partial<PolicyInfo> = {}): PolicyInfo => ({
  schema: 'public',
  table: tableName,
  name: 'p',
  permissive: true,
  roles: ['authenticated'],
  cmd: 'SELECT',
  qual: null,
  withCheck: null,
  ...overrides,
})

export const view = (name: string, overrides: Partial<ViewInfo> = {}): ViewInfo => ({
  schema: 'public',
  view: name,
  materialized: false,
  securityInvoker: false,
  anonSelect: true,
  authSelect: true,
  ...overrides,
})

export const definerFunction = (
  name: string,
  overrides: Partial<SecurityDefinerFunction> = {},
): SecurityDefinerFunction => ({
  schema: 'public',
  name,
  args: '',
  anonExec: true,
  authExec: true,
  ...overrides,
})

export const introspection = (overrides: Partial<Introspection> = {}): Introspection => ({
  tables: [],
  policies: [],
  views: [],
  functions: [],
  ...overrides,
})

/** `(select auth.uid())` as `pg_policies` normalizes it. */
export const WRAPPED_UID = '( SELECT auth.uid() AS uid)'

/** docs/SCHEMAS.md section B, expressions as `pg_policies` reports them. */
export const CARENOTE: Introspection = introspection({
  tables: [
    table('profiles', {
      rlsEnabled: false,
      ownerColumn: 'id',
      sensitive: ['email'],
      columns: [column('id', { indexed: true })],
    }),
    table('patients', {
      ownerColumn: 'clinician_id',
      sensitive: ['dob', 'phone'],
      columns: [column('clinician_id')],
    }),
    table('visit_notes', {
      ownerColumn: 'author_id',
      sensitive: ['diagnosis', 'note'],
      columns: [column('author_id')],
    }),
    table('appointments', { ownerColumn: 'clinician_id', columns: [column('clinician_id')] }),
    table('invoices', { ownerColumn: 'owner_id', columns: [column('owner_id', { indexed: true })] }),
  ],
  policies: [
    policy('patients', { name: 'Authenticated users can view patients', qual: 'true' }),
    policy('patients', {
      name: 'Users can insert patients',
      cmd: 'INSERT',
      withCheck: '(clinician_id = auth.uid())',
    }),
    policy('visit_notes', { name: 'Authors read own notes', qual: '(author_id = auth.uid())' }),
    policy('visit_notes', {
      name: 'Authors update own notes',
      cmd: 'UPDATE',
      qual: '(author_id = auth.uid())',
    }),
    policy('visit_notes', {
      name: 'Clinicians can delete notes',
      cmd: 'DELETE',
      qual: "(auth.role() = 'authenticated'::text)",
    }),
    policy('appointments', { name: 'Read own appointments', qual: '(clinician_id = auth.uid())' }),
    policy('appointments', { name: 'Anyone signed in can book', cmd: 'INSERT', withCheck: 'true' }),
    policy('invoices', { name: 'invoices_owner_read', qual: `(owner_id = ${WRAPPED_UID})` }),
  ],
  views: [view('patient_summary')],
  functions: [definerFunction('search_patients', { args: 'q text' })],
})

const hqReadPolicy = (tableName: string): PolicyInfo =>
  policy(tableName, {
    name: `${tableName}_read`,
    roles: ['anon', 'authenticated'],
    qual: `(EXISTS ( SELECT 1 FROM projects p WHERE ((p.id = ${tableName}.project_id) AND (p.is_public OR (p.owner_id = ${WRAPPED_UID})))))`,
  })

/** docs/SCHEMAS.md section A: least-privilege grants, forced RLS, no bare auth.uid(). */
export const HQ: Introspection = introspection({
  tables: [
    table('projects', {
      rlsForced: true,
      anon: SELECT_ONLY,
      authenticated: { ...SELECT_ONLY, insert: true },
      ownerColumn: 'owner_id',
      columns: [column('owner_id', { indexed: true })],
    }),
    ...['scan_runs', 'findings', 'probe_results'].map((name) =>
      table(name, { rlsForced: true, anon: SELECT_ONLY, authenticated: SELECT_ONLY }),
    ),
  ],
  policies: [
    policy('projects', {
      name: 'projects_read',
      roles: ['anon', 'authenticated'],
      qual: `(is_public OR (owner_id = ${WRAPPED_UID}))`,
    }),
    policy('projects', {
      name: 'projects_insert',
      cmd: 'INSERT',
      withCheck: `(owner_id = ${WRAPPED_UID})`,
    }),
    hqReadPolicy('scan_runs'),
    hqReadPolicy('findings'),
    hqReadPolicy('probe_results'),
  ],
})
