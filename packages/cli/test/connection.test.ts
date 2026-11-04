import { describe, expect, it } from 'vitest'
import { assertAllowedTarget, describeDbError, needsProductionOverride, parseConnection } from '../src/connection'
import { CliError } from '../src/errors'

describe('parseConnection', () => {
  it('reads host and database, and exposes no credentials in its label', () => {
    const target = parseConnection('postgresql://postgres.ref:p%40ss@aws-0.pooler.supabase.com:5432/postgres')
    expect(target.host).toBe('aws-0.pooler.supabase.com')
    expect(target.database).toBe('postgres')
    expect(target.label).toBe('aws-0.pooler.supabase.com/postgres')
    expect(target.isLocal).toBe(false)
  })

  it.each(['localhost', '127.0.0.1', '[::1]'])('treats %s as local', (host) => {
    expect(parseConnection(`postgres://u:p@${host}:5432/x`).isLocal).toBe(true)
  })

  it.each(['localhost.evil.com', '127.0.0.1.nip.io', 'mylocalhost'])('does not treat %s as local', (host) => {
    expect(parseConnection(`postgres://u:p@${host}:5432/x`).isLocal).toBe(false)
  })

  it.each([
    ['not a url', 'hello'],
    ['the wrong scheme', 'mysql://u:p@h/db'],
    ['no host', 'postgres:///db'],
  ])('rejects %s', (_label, url) => {
    expect(() => parseConnection(url)).toThrow(CliError)
  })

  it.each([
    ['a query-string host, which the driver would obey', 'postgres://u:p@localhost/x_test?host=prod.example.com'],
    ['a query-string database', 'postgres://u:p@db.example.com/x_test?database=prod'],
    ['a query-string user', 'postgres://u:p@localhost/x?user=admin'],
    ['server options', 'postgres://u:p@localhost/x?options=-c%20role%3Dadmin'],
    ['a fragment, which the driver and URL parser split differently', 'postgres://u:p@localhost#@prod.example.com/postgres'],
    ['several hosts', 'postgres://u:p@localhost,prod.example.com/x_test'],
    ['no database, which the driver would fill in from PGDATABASE', 'postgres://u:p@localhost'],
  ])('rejects %s', (_label, url) => {
    expect(() => parseConnection(url)).toThrow(CliError)
  })

  it('rejects a malformed percent escape without echoing it', () => {
    expect(() => parseConnection('postgres://u:%zz-secret@localhost/x')).toThrow(/not a valid/)
  })

  it.each(['sslmode=require', 'pgbouncer=true', 'sslmode=require&pgbouncer=true'])('allows %s', (query) => {
    expect(() => parseConnection(`postgres://u:p@localhost/x?${query}`)).not.toThrow()
  })

  it('keeps the fields the driver will be given, decoded', () => {
    expect(parseConnection('postgres://post.ref:p%40ss@db.example.com:6543/my%5Fdb')).toMatchObject({
      host: 'db.example.com',
      port: 6543,
      database: 'my_db',
      username: 'post.ref',
      password: 'p@ss',
    })
  })

  it('defaults the port', () => {
    expect(parseConnection('postgres://u:p@localhost/x').port).toBe(5432)
  })

  describe('ssl', () => {
    it.each([
      ['postgres://u:p@db.example.com/x', 'require'],
      ['postgres://u:p@db.example.com/x?sslmode=require', 'require'],
      ['postgres://u:p@db.example.com/x?sslmode=prefer', 'require'],
      ['postgres://u:p@db.example.com/x?sslmode=allow', 'require'],
      ['postgres://u:p@db.example.com/x?sslmode=verify-full', 'verify-full'],
      ['postgres://u:p@db.example.com/x?sslmode=verify-ca', 'verify-full'],
      ['postgres://u:p@localhost/x', false],
      ['postgres://u:p@localhost/x?sslmode=disable', false],
      ['postgres://u:p@localhost/x?sslmode=require', 'require'],
    ])('%s uses %s', (url, expected) => {
      expect(parseConnection(url).ssl).toBe(expected)
    })

    it('refuses to send a password in the clear to a remote host', () => {
      expect(() => parseConnection('postgres://u:p@db.example.com/x?sslmode=disable')).toThrow(/in the clear/)
    })
  })

  it('never echoes a url it cannot parse, because that url may hold a password', () => {
    const mangled = 'postgres://u:pa?ss/word@host/db'
    try {
      parseConnection(mangled)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(String(error)).not.toContain('pa?ss')
      expect(String(error)).toMatch(/encode/i)
    }
  })
})

describe('production guard', () => {
  it.each([
    ['postgres://u:p@localhost/prod', false],
    ['postgres://u:p@127.0.0.1/anything', false],
    ['postgres://u:p@db.example.com/my_test_db', false],
    ['postgres://u:p@db.example.com/carenote_DEMO', false],
    ['postgres://u:p@db.example.com/staging', false],
    ['postgres://u:p@db.example.com/postgres', true],
    ['postgres://u:p@db.example.com/production', true],
    ['postgres://u:p@aws-0.pooler.supabase.com:5432/postgres', true],
  ])('%s needs the override: %s', (url, expected) => {
    expect(needsProductionOverride(parseConnection(url))).toBe(expected)
  })

  it('throws without the override and passes with it', () => {
    const target = parseConnection('postgres://u:p@db.example.com/postgres')
    expect(() => assertAllowedTarget(target, false)).toThrow(/--i-know-what-im-doing/)
    expect(() => assertAllowedTarget(target, true)).not.toThrow()
  })
})

describe('describeDbError', () => {
  const target = parseConnection('postgres://u:p%40ssword@db.abc.supabase.co:5432/postgres')
  const codeError = (code: string, message = code): Error => Object.assign(new Error(message), { code })

  it.each(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'CONNECT_TIMEOUT'])(
    'suggests the Session pooler on %s',
    (code) => {
      const text = describeDbError(codeError(code), target)
      expect(text).toContain('Session pooler')
      expect(text).toContain('5432')
      expect(text).toContain('db.abc.supabase.co')
    },
  )

  it('explains a failed password without saying what it was', () => {
    const text = describeDbError(codeError('28P01', 'password authentication failed'), target)
    expect(text).toMatch(/password/i)
    expect(text).not.toContain('p@ssword')
  })

  it('explains a missing database', () => {
    expect(describeDbError(codeError('3D000'), target)).toContain('postgres')
  })

  it('scrubs the password from any other message, encoded or not', () => {
    const raw = describeDbError(new Error('boom p@ssword boom'), target)
    const encoded = describeDbError(new Error('boom p%40ssword boom'), target)
    expect(raw).toBe('boom *** boom')
    expect(encoded).toBe('boom *** boom')
  })

  it('handles a thrown non-error', () => {
    expect(describeDbError('weird', target)).toBe('weird')
  })
})
