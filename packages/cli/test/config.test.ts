import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG_FILE, STARTER_CONFIG, loadConfig, parseConfig } from '../src/config'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'

describe('parseConfig', () => {
  it('fills in defaults for an empty object', () => {
    expect(parseConfig({}, 'c.json')).toEqual({
      schemas: ['public'],
      tables: [],
      roles: { anon: true, authenticated: true, service_role: false },
      tenants: { userA: null, userB: null },
      ownerColumns: {},
      allowHosts: [],
      publicTables: [],
    })
  })

  it('accepts exact host names and table names', () => {
    const parsed = parseConfig(
      { allowHosts: ['aws-0-us-east-1.pooler.supabase.com'], publicTables: ['projects', 'public.plans'] },
      'c.json',
    )
    expect(parsed.allowHosts).toEqual(['aws-0-us-east-1.pooler.supabase.com'])
    expect(parsed.publicTables).toEqual(['projects', 'public.plans'])
  })

  it('accepts a host/login entry, as a Supabase pooler needs', () => {
    const entry = 'aws-0-us-east-1.pooler.supabase.com/postgres.abcdefgh'
    expect(parseConfig({ allowHosts: [entry] }, 'c.json').allowHosts).toEqual([entry])
  })

  it('offers allowHosts and publicTables in the starter config, empty', () => {
    const starter = JSON.parse(STARTER_CONFIG) as Record<string, unknown>
    expect(starter.allowHosts).toEqual([])
    expect(starter.publicTables).toEqual([])
  })

  it.each([
    ['*.supabase.com'],
    ['*'],
    ['aws-0-*.pooler.supabase.com'],
    ['db.example.com:5432'],
    ['postgres://db.example.com'],
    ['*.example.com/postgres.ref'],
    ['db.example.com/'],
    ['db.example.com/a/b'],
    ['db.example.com/*'],
    [' db.example.com'],
    [''],
  ])('rejects %j in allowHosts: only one exact host name is allowed', (entry) => {
    expect(() => parseConfig({ allowHosts: [entry] }, 'c.json')).toThrow('allowHosts')
  })

  it('accepts the starter config, whose comments are $comment keys', () => {
    const parsed = parseConfig(JSON.parse(STARTER_CONFIG), 'c.json')
    expect(parsed.tenants).toEqual({ userA: null, userB: null })
    expect(parsed.roles.service_role).toBe(false)
  })

  it('accepts both tenants', () => {
    expect(parseConfig({ tenants: { userA: A, userB: B } }, 'c.json').tenants).toEqual({ userA: A, userB: B })
  })

  it.each([
    ['an unknown key, which is usually a typo', { tabels: [] }, 'tabels'],
    ['an unknown nested key', { roles: { admin: true } }, 'admin'],
    ['a non-uuid tenant', { tenants: { userA: 'alice', userB: B } }, 'tenants.userA'],
    ['only one tenant', { tenants: { userA: A } }, 'tenants'],
    ['the same user twice, which cannot prove a cross-tenant leak', { tenants: { userA: A, userB: A } }, 'different'],
    ['service_role switched on, because it bypasses RLS', { roles: { service_role: true } }, 'bypasses RLS'],
    ['an empty schema list', { schemas: [] }, 'schemas'],
    ['tables of the wrong type', { tables: 'all' }, 'tables'],
    ['an empty owner column', { ownerColumns: { t: '' } }, 'ownerColumns'],
  ])('rejects %s', (_label, config, message) => {
    expect(() => parseConfig(config, 'c.json')).toThrow(message)
  })

  it('names the file in the error', () => {
    expect(() => parseConfig({ tabels: [] }, 'my.json')).toThrow('my.json')
  })
})

describe('loadConfig', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'redrow-config-'))

  it('uses defaults when there is no config file and none was asked for', () => {
    expect(loadConfig(undefined, dir()).schemas).toEqual(['public'])
  })

  it('reads the default file when present', () => {
    const cwd = dir()
    writeFileSync(join(cwd, DEFAULT_CONFIG_FILE), JSON.stringify({ schemas: ['app'] }))
    expect(loadConfig(undefined, cwd).schemas).toEqual(['app'])
  })

  it('fails when an explicit file is missing', () => {
    expect(() => loadConfig('nope.json', dir())).toThrow('nope.json')
  })

  it('reports invalid JSON with the path', () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'bad.json'), '{ nope')
    expect(() => loadConfig('bad.json', cwd)).toThrow(/bad\.json.*JSON/)
  })

  it('is not fooled by a __proto__ key in ownerColumns', () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'c.json'), '{"ownerColumns":{"__proto__":"x"}}')
    const config = loadConfig('c.json', cwd)
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(Object.getPrototypeOf(config.ownerColumns)).toBe(Object.prototype)
  })
})
