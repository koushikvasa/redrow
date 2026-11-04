import { describe, expect, it } from 'vitest'
import { ENGINE_VERSION, scan } from '../src/index'
import type { TableRow } from '../src/introspect'
import engineManifest from '../package.json'
import { fakeSql } from './fake-sql'

const openTable: TableRow = {
  schema: 'public',
  table: 'profiles',
  oid: 1,
  rls_enabled: false,
  rls_forced: false,
  anon_select: true,
  anon_insert: true,
  anon_update: true,
  anon_delete: true,
  auth_select: true,
  auth_insert: true,
  auth_update: true,
  auth_delete: true,
}

const leakyDatabase = () =>
  fakeSql({
    rowsByQuery: {
      'c.relrowsecurity': [openTable],
      'format_type(': [{ table_oid: 1, attnum: 1, column: 'email', type: 'text', writable: true }],
      gen_random_uuid: [{ id: '00000000-0000-4000-8000-00000000000f' }],
    },
    host: ['aws-0-us-east-1.pooler.supabase.com'],
  })

describe('scan', () => {
  it('runs introspection, static rules and scoring into a ScanResult', async () => {
    const result = await scan(leakyDatabase().client, { readOnly: true })

    expect(result.findings.map((f) => f.ruleId)).toEqual(['RR001'])
    expect(result.score).toBe(75)
    expect(result.grade).toBe('D')
    expect(result.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0 })
    expect(result.tables).toEqual([
      {
        schema: 'public',
        table: 'profiles',
        rlsEnabled: false,
        totalRows: 0,
        sensitive: ['email'],
      },
    ])
    expect(result.engineVersion).toBe(ENGINE_VERSION)
    expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('never commits, across a full scan with write probes', async () => {
    const sql = leakyDatabase()
    await scan(sql.client)
    expect(sql.transactions.committed).toBe(0)
    expect(sql.transactions.rolledBack).toBeGreaterThan(0)
  })

  it('adds probe results and the findings they prove', async () => {
    const result = await scan(leakyDatabase().client, {})
    expect(result.probes.length).toBeGreaterThan(0)
    // The fake returns success for `insert ... default values`, so anon can "write".
    expect(result.findings.map((f) => f.ruleId)).toContain('RR106')
  })

  it('uses configured actors without generating any', async () => {
    const actors = { userA: 'a', userB: 'b' }
    const sql = leakyDatabase()
    expect((await scan(sql.client, { actors })).actors).toEqual(actors)
    expect(sql.queries.some((q) => q.text.includes('gen_random_uuid'))).toBe(false)
  })

  it('generates ids when the data has no owners to impersonate', async () => {
    const ids = ['id-1', 'id-2']
    let next = 0
    const sql = fakeSql({
      respond: (text) => (text.includes('gen_random_uuid') ? [{ id: ids[next++] }] : undefined),
    })
    expect((await scan(sql.client)).actors).toEqual({ userA: 'id-1', userB: 'id-2' })
  })

  it('takes actors from the owners found in the tables', async () => {
    const owner = '00000000-0000-4000-8000-00000000000a'
    const sql = fakeSql({
      rowsByQuery: {
        'c.relrowsecurity': [{ ...openTable, rls_enabled: true }],
        'format_type(': [{ table_oid: 1, attnum: 1, column: 'user_id', type: 'uuid', writable: true }],
        'group by': [{ owner, n: 2 }],
        gen_random_uuid: [{ id: 'random' }],
      },
    })
    expect((await scan(sql.client)).actors).toEqual({ userA: owner, userB: 'random' })
  })

  it('has no warnings for a role that bypasses RLS', async () => {
    const sql = fakeSql({ rowsByQuery: { rolbypassrls: [{ role: 'postgres', bypass: true }] } })
    expect((await scan(sql.client)).warnings).toEqual([])
  })

  it('warns when the connecting role does not bypass RLS, since leaks can then be missed', async () => {
    const sql = fakeSql({ rowsByQuery: { rolbypassrls: [{ role: 'app_user', bypass: false }] } })
    const { warnings } = await scan(sql.client)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('app_user')
  })

  it('warns about a table it could not probe, by name', async () => {
    const sql = fakeSql({
      rowsByQuery: { 'c.relrowsecurity': [{ ...openTable, table: 'a.b' }] },
    })
    const { warnings } = await scan(sql.client)
    expect(warnings.some((w) => w.includes('public.a.b'))).toBe(true)
  })

  it('reports the phases in order', async () => {
    const phases: string[] = []
    await scan(fakeSql().client, { onPhase: (phase) => phases.push(phase) })
    expect(phases).toEqual(['introspect', 'actors', 'probes'])
  })

  it('reports totals from the probe phase', async () => {
    const sql = fakeSql({
      rowsByQuery: {
        'c.relrowsecurity': [openTable],
        'count(*)::int as n': [{ n: 42 }],
        gen_random_uuid: [{ id: 'x' }],
      },
    })
    expect((await scan(sql.client, { readOnly: true })).tables[0]?.totalRows).toBe(42)
  })

  describe('limiting to named tables', () => {
    const twoTables = () =>
      fakeSql({
        rowsByQuery: {
          'c.relrowsecurity': [openTable, { ...openTable, table: 'other', oid: 2 }],
          'c.relkind in (\'v\',\'m\')': [
            { schema: 'public', view: 'v', relkind: 'v', security_invoker: false, anon_select: true, auth_select: true },
          ],
          'p.prosecdef': [{ schema: 'public', name: 'f', args: '', anon_exec: true, auth_exec: true }],
          pg_policies: [
            {
              schema: 'public',
              table: 'other',
              name: 'p',
              permissive: 'PERMISSIVE',
              roles: ['authenticated'],
              cmd: 'SELECT',
              qual: 'auth.uid()',
              with_check: null,
            },
          ],
        },
      })

    it('scans only those tables, and leaves out views, functions and other policies', async () => {
      const result = await scan(twoTables().client, { tables: ['profiles'], readOnly: true })
      expect(result.tables.map((t) => t.table)).toEqual(['profiles'])
      expect(result.findings.map((f) => f.ruleId)).toEqual(['RR001'])
      expect(result.findings.every((f) => f.table === 'profiles')).toBe(true)
    })

    it('rejects a table that does not exist, so a typo cannot pass as a clean scan', async () => {
      await expect(scan(twoTables().client, { tables: ['typo'] })).rejects.toThrow(/typo/)
    })

    it('treats an empty list as no limit', async () => {
      const result = await scan(twoTables().client, { tables: [], readOnly: true })
      expect(result.tables).toHaveLength(2)
    })
  })

  it("defaults to the public schema and reports the driver's host and database", async () => {
    const sql = leakyDatabase()
    const result = await scan(sql.client)
    expect(result.target).toEqual({
      host: 'aws-0-us-east-1.pooler.supabase.com',
      database: 'app_test',
      schemas: ['public'],
    })
    expect(sql.queries.some((q) => JSON.stringify(q.values) === '[["public"]]')).toBe(true)
  })

  it('scans the schemas it is given', async () => {
    const result = await scan(fakeSql().client, { schemas: ['app'] })
    expect(result.target.schemas).toEqual(['app'])
  })

  it('passes configured owner columns through to the report', async () => {
    const result = await scan(leakyDatabase().client, { ownerColumns: { profiles: 'email' } })
    expect(result.tables[0]?.ownerColumn).toBe('email')
  })

  it('rejects an empty schema list', async () => {
    await expect(scan(fakeSql().client, { schemas: [] })).rejects.toThrow(/at least one schema/)
  })

  it('never puts the database password in the report', async () => {
    const result = await scan(leakyDatabase().client)
    expect(JSON.stringify(result)).not.toContain('hunter2')
  })

  it('keeps ENGINE_VERSION in step with package.json', () => {
    expect(ENGINE_VERSION).toBe(engineManifest.version)
  })
})
