import { describe, expect, it } from 'vitest'
import {
  buildIntrospection,
  detectOwnerColumn,
  findSensitiveColumns,
  introspect,
  type AuthUserFkRow,
  type CatalogRows,
  type TableRow,
} from '../src/introspect'
import { column } from './fixtures'
import { fakeSql } from './fake-sql'

const fk = (columnName: string, isSolePk = false): AuthUserFkRow => ({
  table_oid: 1,
  column: columnName,
  is_sole_pk: isSolePk,
})

describe('detectOwnerColumn', () => {
  it('prefers an FK to auth.users over a name match', () => {
    const columns = [column('user_id'), column('clinician_id')]
    expect(detectOwnerColumn(columns, [fk('clinician_id')])).toBe('clinician_id')
  })

  it('breaks ties between FKs using the owner-name order', () => {
    const columns = [column('approved_by'), column('created_by'), column('user_id')]
    const fks = [fk('approved_by'), fk('created_by'), fk('user_id')]
    expect(detectOwnerColumn(columns, fks)).toBe('user_id')
  })

  it('falls back to column order between FKs with unknown names', () => {
    const columns = [column('approved_by'), column('reviewed_by')]
    expect(detectOwnerColumn(columns, [fk('reviewed_by'), fk('approved_by')])).toBe('approved_by')
  })

  it.each(['user_id', 'owner_id', 'created_by', 'author_id', 'profile_id', 'clinician_id', 'account_id'])(
    'recognizes the uuid column %s by name',
    (name) => {
      expect(detectOwnerColumn([column(name)], [])).toBe(name)
    },
  )

  it('ignores a matching name on a non-uuid column', () => {
    expect(detectOwnerColumn([column('user_id', { type: 'text' })], [])).toBeUndefined()
  })

  it('uses a primary key that is an FK to auth.users', () => {
    expect(detectOwnerColumn([column('id')], [fk('id', true)])).toBe('id')
  })

  it('prefers that primary key over a column matching the name heuristic', () => {
    const columns = [column('id'), column('account_id')]
    expect(detectOwnerColumn(columns, [fk('id', true)])).toBe('id')
  })

  it('prefers that primary key over another FK, so profiles.id beats created_by', () => {
    const columns = [column('id'), column('created_by')]
    expect(detectOwnerColumn(columns, [fk('created_by'), fk('id', true)])).toBe('id')
  })

  it('treats a member of a composite primary key as an ordinary FK', () => {
    const columns = [column('org_id'), column('member_ref')]
    expect(detectOwnerColumn(columns, [fk('member_ref', false)])).toBe('member_ref')
  })

  it('returns undefined when nothing identifies an owner', () => {
    expect(detectOwnerColumn([column('id'), column('name', { type: 'text' })], [])).toBeUndefined()
  })
})

describe('findSensitiveColumns', () => {
  it('matches on any substring, case-insensitively', () => {
    expect(
      findSensitiveColumns(['Email_Address', 'dob', 'visit_notes', 'api_token', 'created_at', 'name']),
    ).toEqual(['Email_Address', 'dob', 'visit_notes', 'api_token'])
  })

  it.each([
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
  ])('flags %s', (name) => {
    expect(findSensitiveColumns([`x_${name}_y`])).toHaveLength(1)
  })
})

const tableRow = (overrides: Partial<TableRow> = {}): TableRow => ({
  schema: 'public',
  table: 'patients',
  oid: 1,
  rls_enabled: true,
  rls_forced: false,
  anon_select: true,
  anon_insert: false,
  anon_update: false,
  anon_delete: false,
  auth_select: true,
  auth_insert: true,
  auth_update: true,
  auth_delete: false,
  ...overrides,
})

const CATALOG: CatalogRows = {
  tables: [tableRow(), tableRow({ table: 'other', oid: 2 })],
  columns: [
    { table_oid: 1, attnum: 1, column: 'id', type: 'uuid', writable: false },
    { table_oid: 1, attnum: 2, column: 'clinician_id', type: 'uuid', writable: true },
    { table_oid: 1, attnum: 3, column: 'dob', type: 'date', writable: true },
    { table_oid: 2, attnum: 1, column: 'label', type: 'text', writable: true },
  ],
  policies: [
    {
      schema: 'public',
      table: 'patients',
      name: 'p',
      permissive: 'RESTRICTIVE',
      roles: ['authenticated'],
      cmd: 'SELECT',
      qual: 'true',
      with_check: null,
    },
  ],
  views: [
    {
      schema: 'public',
      view: 'mv',
      relkind: 'm',
      security_invoker: false,
      anon_select: true,
      auth_select: false,
    },
  ],
  functions: [{ schema: 'public', name: 'f', args: 'q text', anon_exec: true, auth_exec: true }],
  authUserFks: [
    { table_oid: 2, column: 'label', is_sole_pk: false },
    { table_oid: 1, column: 'clinician_id', is_sole_pk: false },
    // An FK from a table outside the scanned schemas is ignored.
    { table_oid: 99, column: 'user_id', is_sole_pk: false },
  ],
  indexes: [
    { table_oid: 1, attnum: 1 },
    { table_oid: 2, attnum: 1 },
  ],
}

describe('buildIntrospection', () => {
  it('maps grants, owner, sensitive columns and index coverage per table', () => {
    const [patients] = buildIntrospection(CATALOG).tables
    expect(patients).toMatchObject({
      schema: 'public',
      table: 'patients',
      rlsEnabled: true,
      rlsForced: false,
      anon: { select: true, insert: false, update: false, delete: false },
      authenticated: { select: true, insert: true, update: true, delete: false },
      ownerColumn: 'clinician_id',
      sensitive: ['dob'],
    })
    expect(patients?.columns.map((c) => [c.name, c.indexed])).toEqual([
      ['id', true],
      ['clinician_id', false],
      ['dob', false],
    ])
  })

  it('keeps columns and FKs on their own table', () => {
    const other = buildIntrospection(CATALOG).tables[1]
    expect(other?.columns.map((c) => c.name)).toEqual(['label'])
    expect(other?.ownerColumn).toBe('label')
  })

  it('leaves ownerColumn off when no owner is found', () => {
    const rows: CatalogRows = { ...CATALOG, authUserFks: [] }
    expect(buildIntrospection(rows).tables[1]).not.toHaveProperty('ownerColumn')
  })

  it('maps policies, views and functions to camelCase domain types', () => {
    const result = buildIntrospection(CATALOG)
    expect(result.policies[0]).toEqual({
      schema: 'public',
      table: 'patients',
      name: 'p',
      permissive: false,
      roles: ['authenticated'],
      cmd: 'SELECT',
      qual: 'true',
      withCheck: null,
    })
    expect(result.views[0]).toEqual({
      schema: 'public',
      view: 'mv',
      materialized: true,
      securityInvoker: false,
      anonSelect: true,
      authSelect: false,
    })
    expect(result.functions[0]).toEqual({
      schema: 'public',
      name: 'f',
      args: 'q text',
      anonExec: true,
      authExec: true,
    })
  })

  it('lets configured owner columns win over detection', () => {
    const [patients] = buildIntrospection(CATALOG, { patients: 'id' }).tables
    expect(patients?.ownerColumn).toBe('id')
  })

  it('rejects a configured column that does not exist, naming the table and column', () => {
    expect(() => buildIntrospection(CATALOG, { patients: 'nope' })).toThrow(/public\.patients.*"nope"/)
  })

  it('ignores configuration for tables outside the scan', () => {
    expect(() => buildIntrospection(CATALOG, { elsewhere: 'x' })).not.toThrow()
  })

  it('is not fooled by a table named after an Object.prototype member', () => {
    const rows: CatalogRows = {
      ...CATALOG,
      tables: [tableRow({ table: 'constructor', oid: 3 })],
      columns: [],
      authUserFks: [],
    }
    expect(buildIntrospection(rows).tables[0]).not.toHaveProperty('ownerColumn')
  })
})

describe('introspect', () => {
  it.each(['42P01', '3F000', '42704'])(
    'explains a missing Supabase object (SQLSTATE %s), keeping the server message and cause',
    async (code) => {
      const failure = Object.assign(new Error('role "anon" does not exist'), { code })
      const rejection = introspect(fakeSql({ failWith: failure }).client, ['public'])
      await expect(rejection).rejects.toThrow(/doesn't look like a Supabase database: role "anon"/)
      await expect(rejection).rejects.toHaveProperty('cause', failure)
    },
  )

  it('passes any other database error through unchanged', async () => {
    const failure = Object.assign(new Error('connection terminated'), { code: '08006' })
    await expect(introspect(fakeSql({ failWith: failure }).client, ['public'])).rejects.toBe(failure)
  })

  it('runs every catalog query, passing schemas as a bound parameter', async () => {
    const sql = fakeSql()
    await introspect(sql.client, ['public', 'app'])
    expect(sql.queries).toHaveLength(7)
    const withSchemas = sql.queries.filter((q) => q.values.length > 0)
    expect(withSchemas.length).toBeGreaterThan(0)
    for (const query of withSchemas) {
      expect(query.values).toEqual([['public', 'app']])
    }
  })

  it('only ever reads the system catalogs: no user table, no select *', async () => {
    const sql = fakeSql()
    await introspect(sql.client, ['public'])
    for (const query of sql.queries) {
      expect(query.text).not.toMatch(/select\s+\*/i)
      const sources = [...query.text.matchAll(/\b(?:from|join)\s+([\w.]+)/gi)].map((m) => m[1] as string)
      for (const source of sources) {
        expect(source).toMatch(/^(pg_\w+|unnest)$/)
      }
    }
  })
})
