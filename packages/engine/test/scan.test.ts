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
      'format_type(': [{ table_oid: 1, attnum: 1, column: 'email', type: 'text' }],
    },
    host: ['aws-0-us-east-1.pooler.supabase.com'],
  })

describe('scan', () => {
  it('runs introspection, static rules and scoring into a ScanResult', async () => {
    const result = await scan(leakyDatabase().client, {})

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

  it('leaves the probe phase empty until probes exist', async () => {
    const result = await scan(fakeSql().client)
    expect(result.probes).toEqual([])
    expect(result.actors).toEqual({ userA: '', userB: '' })
  })

  it("defaults to the public schema and reports the driver's host", async () => {
    const sql = leakyDatabase()
    const result = await scan(sql.client)
    expect(result.target).toEqual({
      host: 'aws-0-us-east-1.pooler.supabase.com',
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
