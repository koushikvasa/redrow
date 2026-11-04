import { describe, expect, it } from 'vitest'
import { findingsFromProbes, mergeFindings, type ProbeContext } from '../src/dynamic'
import { makeFinding } from '../src/rules'
import type { Finding, ProbeAction, ProbeActor, ProbeOutcome, ProbeResult } from '../src/types'
import { introspection, policy, table } from './fixtures'

const probe = (
  actor: ProbeActor,
  action: ProbeAction,
  outcome: ProbeOutcome,
  rowCount: number | null,
  tableName = 't',
): ProbeResult => ({ schema: 'public', table: tableName, actor, action, outcome, rowCount })

const ownedContext: ProbeContext = {
  introspection: introspection({
    tables: [table('t', { ownerColumn: 'user_id' })],
    policies: [
      policy('t', { name: 'read_all', cmd: 'SELECT', qual: 'true' }),
      policy('t', { name: 'write_all', cmd: 'ALL', qual: 'true', withCheck: 'true' }),
      policy('t', { name: 'svc', cmd: 'DELETE', roles: ['service_role'], qual: 'true' }),
    ],
  }),
  totals: new Map([['public.t', 10]]),
}

const single = (probes: readonly ProbeResult[], context: ProbeContext = ownedContext): Finding => {
  const findings = findingsFromProbes(probes, context)
  expect(findings).toHaveLength(1)
  return findings[0] as Finding
}

describe('findingsFromProbes', () => {
  it('RR101: anon reading an owned table is critical and reports the count', () => {
    const finding = single([probe('anon', 'select_all', 'allowed', 7)])
    expect(finding).toMatchObject({ ruleId: 'RR101', severity: 'critical', table: 't', rowsExposed: 7 })
    expect(finding.detail).toContain('7 rows')
    expect(finding.probe).toEqual({ actor: 'anon', action: 'select_all', outcome: 'allowed', rowCount: 7 })
  })

  it('RR101 also covers sensitive tables with no owner', () => {
    const context: ProbeContext = {
      introspection: introspection({ tables: [table('t', { sensitive: ['email'] })] }),
      totals: new Map(),
    }
    expect(single([probe('anon', 'select_all', 'allowed', 1)], context).ruleId).toBe('RR101')
  })

  it('RR101 stays silent for a public lookup table with no owner or sensitive columns', () => {
    const context: ProbeContext = {
      introspection: introspection({ tables: [table('t')] }),
      totals: new Map(),
    }
    expect(findingsFromProbes([probe('anon', 'select_all', 'allowed', 5)], context)).toEqual([])
  })

  it.each([
    ['select_others', 'RR102', 'critical'],
    ['update_other', 'RR103', 'critical'],
    ['delete_other', 'RR104', 'critical'],
    ['insert_other', 'RR105', 'high'],
  ] as const)('%s by user A maps to %s (%s)', (action, ruleId, severity) => {
    expect(single([probe('user_a', action, 'allowed', 3)])).toMatchObject({
      ruleId,
      severity,
      rowsExposed: 3,
    })
  })

  it.each(['update_any', 'delete_any', 'insert_other'] as const)(
    'RR106: anon succeeding at %s is high',
    (action) => {
      expect(single([probe('anon', action, 'allowed', 2)])).toMatchObject({
        ruleId: 'RR106',
        severity: 'high',
      })
    },
  )

  it('names the API policies for the command, including ALL but not service_role ones', () => {
    expect(single([probe('user_a', 'delete_other', 'allowed', 1)]).policy).toBe('write_all')
    expect(single([probe('user_a', 'select_others', 'allowed', 1)]).policy).toBe('read_all, write_all')
  })

  it('leaves policy off when none applies', () => {
    const context: ProbeContext = {
      introspection: introspection({ tables: [table('t', { ownerColumn: 'user_id', rlsEnabled: false })] }),
      totals: new Map(),
    }
    expect(single([probe('user_a', 'select_others', 'allowed', 1)], context)).not.toHaveProperty('policy')
  })

  it('reports an insert blocked only by a later constraint, without inventing a row count', () => {
    const finding = single([probe('user_a', 'insert_other', 'allowed', null)])
    expect(finding.ruleId).toBe('RR105')
    expect(finding).not.toHaveProperty('rowsExposed')
    expect(finding.detail).toMatch(/complete row/i)
  })

  it.each(['denied', 'inconclusive', 'not_applicable'] as const)(
    'raises nothing for a %s probe',
    (outcome) => {
      expect(findingsFromProbes([probe('user_a', 'select_others', outcome, 0)], ownedContext)).toEqual([])
    },
  )

  it("raises nothing when user A only sees their own rows", () => {
    expect(findingsFromProbes([probe('user_a', 'select_own', 'allowed', 4)], ownedContext)).toEqual([])
  })

  describe('RR003 evidence on an un-owned table', () => {
    const context = (overrides: Parameters<typeof table>[1] = {}): ProbeContext => ({
      introspection: introspection({ tables: [table('t', { sensitive: ['email'], ...overrides })] }),
      totals: new Map([['public.t', 10]]),
    })

    it('fires when a signed-in user sees every row of a sensitive table', () => {
      expect(single([probe('user_a', 'select_all', 'allowed', 10)], context()).ruleId).toBe('RR003')
    })

    it('stays silent when the user sees only some rows', () => {
      expect(findingsFromProbes([probe('user_a', 'select_all', 'allowed', 9)], context())).toEqual([])
    })

    it('stays silent with no sensitive columns', () => {
      expect(
        findingsFromProbes([probe('user_a', 'select_all', 'allowed', 10)], context({ sensitive: [] })),
      ).toEqual([])
    })

    it('leaves RLS-off tables to RR001 and RR002', () => {
      expect(
        findingsFromProbes([probe('user_a', 'select_all', 'allowed', 10)], context({ rlsEnabled: false })),
      ).toEqual([])
    })
  })

  it('ignores a probe for a table it does not know', () => {
    expect(findingsFromProbes([probe('anon', 'select_all', 'allowed', 1, 'ghost')], ownedContext)).toEqual([])
  })
})

describe('mergeFindings', () => {
  const staticRr003 = makeFinding(
    'RR003',
    { schema: 'public', table: 't', policy: 'open' },
    'Policy "open" has USING (true).',
  )
  const dynamicRr102 = makeFinding('RR102', { schema: 'public', table: 't' }, 'A read 5 rows.')

  it('suppresses RR003 when RR102 proves the same table, keeping its text as the explanation', () => {
    const merged = mergeFindings([staticRr003], [dynamicRr102])
    expect(merged.map((f) => f.ruleId)).toEqual(['RR102'])
    expect(merged[0]?.detail).toContain('A read 5 rows.')
    expect(merged[0]?.detail).toContain('USING (true)')
    expect(merged[0]?.policy).toBe('open')
  })

  it('keeps RR003 when RR102 fired on a different table', () => {
    const other = makeFinding('RR102', { schema: 'public', table: 'other' }, 'x')
    expect(mergeFindings([staticRr003], [other]).map((f) => f.ruleId)).toEqual(['RR003', 'RR102'])
  })

  it('does not confuse tables with the same name in different schemas', () => {
    const other = makeFinding('RR102', { schema: 'app', table: 't' }, 'x')
    expect(mergeFindings([staticRr003], [other]).map((f) => f.ruleId)).toEqual(['RR003', 'RR102'])
  })

  it('drops a dynamic RR003 when the static rule already reported that table', () => {
    const dynamicRr003 = makeFinding('RR003', { schema: 'public', table: 't' }, 'saw all rows')
    expect(mergeFindings([staticRr003], [dynamicRr003])).toEqual([staticRr003])
  })

  it('leaves everything else alone', () => {
    const staticOther = makeFinding('RR008', { schema: 'public', table: 't', policy: 'p' }, 'y')
    expect(mergeFindings([staticOther], [])).toEqual([staticOther])
  })
})
