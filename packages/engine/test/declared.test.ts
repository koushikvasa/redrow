import { describe, expect, it } from 'vitest'
import { applyDeclaredExposure } from '../src/declared'
import { makeFinding, type RuleId } from '../src/rules'
import { runStaticRules } from '../src/static'
import { scoreFindings } from '../src/score'
import type { Finding, Introspection, TableInfo } from '../src/types'
import { ALL_PRIVILEGES, HQ, SELECT_ONLY, introspection, policy, table } from './fixtures'

const finding = (ruleId: RuleId, tableName = 't', extra: Partial<Finding> = {}): Finding => ({
  ...makeFinding(ruleId, { schema: 'public', table: tableName }, 'detail'),
  ...extra,
})

const anonRead = (tableName = 't'): Finding =>
  finding('RR101', tableName, {
    rowsExposed: 2,
    probe: { actor: 'anon', action: 'select_all', outcome: 'allowed', rowCount: 2 },
  })

const owned = (overrides: Partial<TableInfo> = {}): TableInfo =>
  table('t', { ownerColumn: 'user_id', anon: SELECT_ONLY, ...overrides })

const withTable = (t: TableInfo = owned()): Introspection => introspection({ tables: [t] })

describe('applyDeclaredExposure', () => {
  it('turns anon reading a declared-public table into declared exposure at info', () => {
    const [result] = applyDeclaredExposure([anonRead()], withTable(), ['t'])
    expect(result?.severity).toBe('info')
    expect(result?.ruleId).toBe('RR101')
    expect(result?.detail).toMatch(/^Declared exposure: /)
    expect(result?.fixHint).toContain('publicTables')
    expect(result?.rowsExposed).toBe(2)
  })

  it('leaves the finding alone when the table is not declared', () => {
    const input = [anonRead()]
    expect(applyDeclaredExposure(input, withTable(), ['other'])).toEqual(input)
  })

  it('leaves everything alone with an empty list', () => {
    const input = [anonRead()]
    expect(applyDeclaredExposure(input, withTable(), [])).toEqual(input)
  })

  it('accepts schema.table, and then does not match the same name in another schema', () => {
    const inApp = owned({ schema: 'app' })
    const appFinding = { ...anonRead(), schema: 'app' }
    const both = introspection({ tables: [owned(), inApp] })
    const [publicResult, appResult] = applyDeclaredExposure([anonRead(), appFinding], both, ['public.t'])
    expect(publicResult?.severity).toBe('info')
    expect(appResult?.severity).toBe('critical')
  })

  it.each([
    ['RR102', 'a signed-in user reading others'],
    ['RR103', 'a signed-in user updating others'],
    ['RR104', 'a signed-in user deleting others'],
    ['RR105', 'a signed-in user inserting for others'],
    ['RR106', 'anon writing'],
    ['RR002', 'RLS off with no anon read'],
    ['RR004', 'an update policy'],
    ['RR005', 'an insert policy'],
    ['RR008', 'a slow policy'],
    ['RR009', 'a missing index'],
    ['RR010', 'no policies'],
  ] as const)('still counts %s (%s) on a declared-public table', (ruleId, _what) => {
    const input = [finding(ruleId)]
    expect(applyDeclaredExposure(input, withTable(), ['t'])).toEqual(input)
  })

  describe('RR001, RLS disabled', () => {
    const readOnlyForAll = { rlsEnabled: false, anon: SELECT_ONLY, authenticated: SELECT_ONLY }

    it('downgrades when no API role can write', () => {
      const [result] = applyDeclaredExposure([finding('RR001')], withTable(owned(readOnlyForAll)), ['t'])
      expect(result?.severity).toBe('info')
    })

    it('still counts when anon also holds a write grant, since RLS off means it works on every row', () => {
      const t = owned({ ...readOnlyForAll, anon: ALL_PRIVILEGES })
      const [result] = applyDeclaredExposure([finding('RR001')], withTable(t), ['t'])
      expect(result?.severity).toBe('critical')
    })

    // RR001 returns early, so RR002 never reports these grants: RR001 is the only finding that covers them.
    it.each(['insert', 'update', 'delete'] as const)(
      'still counts when authenticated can %s every row, which nothing else would report',
      (grant) => {
        const t = owned({ ...readOnlyForAll, authenticated: { ...SELECT_ONLY, [grant]: true } })
        const [result] = applyDeclaredExposure([finding('RR001')], withTable(t), ['t'])
        expect(result?.severity).toBe('critical')
      },
    )
  })

  describe('write exposure the probes may not have seen', () => {
    // This must hold without any write probe, because --read-only never runs them.
    const withPolicy = (overrides: Parameters<typeof policy>[1]): Introspection =>
      introspection({ tables: [owned()], policies: [policy('t', { name: 'w', ...overrides })] })

    it.each(['INSERT', 'UPDATE', 'DELETE', 'ALL'] as const)(
      'keeps RR101 when a %s policy lets anon write',
      (cmd) => {
        const [result] = applyDeclaredExposure([anonRead()], withPolicy({ cmd, roles: ['anon'], qual: 'true' }), ['t'])
        expect(result?.severity).toBe('critical')
      },
    )

    it('treats a policy for the default public role as applying to anon', () => {
      const input = withPolicy({ cmd: 'DELETE', roles: ['public'], qual: 'true' })
      expect(applyDeclaredExposure([anonRead()], input, ['t'])[0]?.severity).toBe('critical')
    })

    it('keeps RR003 too when anon has a separate write policy', () => {
      const input = introspection({
        tables: [owned()],
        policies: [
          policy('t', { name: 'p', cmd: 'SELECT', roles: ['anon'], qual: 'true' }),
          policy('t', { name: 'w', cmd: 'DELETE', roles: ['anon'], qual: 'true' }),
        ],
      })
      const [result] = applyDeclaredExposure([finding('RR003', 't', { policy: 'p' })], input, ['t'])
      expect(result?.severity).toBe('high')
    })

    it('ignores write policies for other roles, as HQ needs', () => {
      const input = withPolicy({ cmd: 'INSERT', roles: ['authenticated'], withCheck: 'true' })
      expect(applyDeclaredExposure([anonRead()], input, ['t'])[0]?.severity).toBe('info')
    })

    it('ignores a restrictive policy, which cannot grant a write', () => {
      const input = withPolicy({ cmd: 'DELETE', roles: ['anon'], permissive: false, qual: 'true' })
      expect(applyDeclaredExposure([anonRead()], input, ['t'])[0]?.severity).toBe('info')
    })

    it('ignores a write policy on a different table', () => {
      const input = introspection({
        tables: [owned()],
        policies: [policy('other', { name: 'w', cmd: 'DELETE', roles: ['anon'], qual: 'true' })],
      })
      expect(applyDeclaredExposure([anonRead()], input, ['t'])[0]?.severity).toBe('info')
    })

    it('does not count default grants as exposure while RLS is on, since RLS then decides', () => {
      const t = owned({ anon: ALL_PRIVILEGES })
      expect(applyDeclaredExposure([anonRead()], withTable(t), ['t'])[0]?.severity).toBe('info')
    })

    it('keeps RR101 with RLS off when anyone can write', () => {
      const t = owned({ rlsEnabled: false, anon: SELECT_ONLY, authenticated: ALL_PRIVILEGES })
      expect(applyDeclaredExposure([anonRead()], withTable(t), ['t'])[0]?.severity).toBe('critical')
    })
  })

  describe('naming', () => {
    const inSchema = (schema: string): Introspection => introspection({ tables: [owned({ schema })] })
    const readIn = (schema: string): Finding => ({ ...anonRead(), schema })

    it('reads a bare name as the public schema only, so it cannot reach private.t', () => {
      expect(applyDeclaredExposure([readIn('private')], inSchema('private'), ['t'])[0]?.severity).toBe('critical')
    })

    it('needs schema.table for any other schema', () => {
      expect(applyDeclaredExposure([readIn('app')], inSchema('app'), ['app.t'])[0]?.severity).toBe('info')
    })
  })

  it('says so when the declared table has sensitive columns', () => {
    const t = owned({ sensitive: ['email', 'token'] })
    const [result] = applyDeclaredExposure([anonRead()], withTable(t), ['t'])
    expect(result?.severity).toBe('info')
    expect(result?.detail).toContain('Sensitive columns: email, token.')
  })

  describe('RR003, a read policy matching every row', () => {
    const openRead = (overrides: Parameters<typeof policy>[1]): Introspection =>
      introspection({
        tables: [owned()],
        policies: [policy('t', { name: 'p', qual: 'true', ...overrides })],
      })
    const rr003 = finding('RR003', 't', { policy: 'p' })

    it.each([['anon'], ['public']])('downgrades a SELECT policy that %s can use', (role) => {
      const [result] = applyDeclaredExposure([rr003], openRead({ cmd: 'SELECT', roles: [role] }), ['t'])
      expect(result?.severity).toBe('info')
    })

    it('still counts a policy for authenticated only, because that is not anon', () => {
      const [result] = applyDeclaredExposure([rr003], openRead({ cmd: 'SELECT', roles: ['authenticated'] }), ['t'])
      expect(result?.severity).toBe('high')
    })

    it('still counts a FOR ALL policy, because it grants writes too', () => {
      const [result] = applyDeclaredExposure([rr003], openRead({ cmd: 'ALL', roles: ['anon'] }), ['t'])
      expect(result?.severity).toBe('high')
    })

    it('still counts one proved by a signed-in user', () => {
      const proved = finding('RR003', 't', {
        probe: { actor: 'user_a', action: 'select_all', outcome: 'allowed', rowCount: 3 },
      })
      expect(applyDeclaredExposure([proved], withTable(), ['t'])).toEqual([proved])
    })
  })

  it('ignores a finding with no table, such as a function', () => {
    const fn = makeFinding('RR007', { schema: 'public', functionName: 'f' }, 'x')
    expect(applyDeclaredExposure([fn], withTable(), ['t'])).toEqual([fn])
  })

  it('leaves a view named in the list alone, because the list is for tables', () => {
    const view = finding('RR006', 't')
    expect(applyDeclaredExposure([view], withTable(), ['t'])).toEqual([view])
  })
})

describe('scoring declared exposure', () => {
  it('costs nothing and keeps grade A, while still being counted', () => {
    const [declared] = applyDeclaredExposure([anonRead()], withTable(), ['t'])
    const result = scoreFindings([declared as Finding])
    expect(result.score).toBe(100)
    expect(result.grade).toBe('A')
    expect(result.counts.info).toBe(1)
    expect(result.counts.critical).toBe(0)
  })

  it('does not let info hide a real finding on the same table', () => {
    const [declared] = applyDeclaredExposure([anonRead()], withTable(), ['t'])
    const result = scoreFindings([declared as Finding, finding('RR106')])
    expect(result.score).toBe(90)
  })

  it('takes HQ to 100 with projects declared public', () => {
    const projects = HQ.tables.find((t) => t.table === 'projects') as TableInfo
    const findings = [...runStaticRules(HQ), anonRead('projects')]
    expect(scoreFindings(findings).score).toBe(75)
    const declared = applyDeclaredExposure(findings, HQ, [projects.table])
    expect(scoreFindings(declared).score).toBe(100)
  })
})
