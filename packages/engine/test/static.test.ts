import { describe, expect, it } from 'vitest'
import { runStaticRules, usesBareAuthUid } from '../src/static'
import { scoreFindings } from '../src/score'
import type { Finding, Introspection } from '../src/types'
import {
  ALL_PRIVILEGES,
  CARENOTE,
  HQ,
  NO_PRIVILEGES,
  SELECT_ONLY,
  WRAPPED_UID,
  column,
  definerFunction,
  introspection,
  policy,
  table,
  view,
} from './fixtures'

const ruleIds = (input: Introspection): string[] => runStaticRules(input).map((f) => f.ruleId)

const only = (input: Introspection, ruleId: string): Finding => {
  const matches = runStaticRules(input).filter((f) => f.ruleId === ruleId)
  expect(matches).toHaveLength(1)
  return matches[0] as Finding
}

describe('RR001 / RR002: RLS disabled', () => {
  it('reports RR001 when anon can select', () => {
    const input = introspection({ tables: [table('t', { rlsEnabled: false })] })
    expect(only(input, 'RR001').severity).toBe('critical')
    expect(ruleIds(input)).not.toContain('RR002')
  })

  it('reports RR002 when only authenticated has privileges', () => {
    const input = introspection({ tables: [table('t', { rlsEnabled: false, anon: NO_PRIVILEGES })] })
    expect(only(input, 'RR002').severity).toBe('high')
    expect(ruleIds(input)).not.toContain('RR001')
  })

  it('reports RR002 when anon can write but not read, rather than scoring the table clean', () => {
    const input = introspection({
      tables: [
        table('t', {
          rlsEnabled: false,
          anon: { ...NO_PRIVILEGES, insert: true },
          authenticated: NO_PRIVILEGES,
        }),
      ],
    })
    expect(only(input, 'RR002').detail).toContain('so anon can use')
  })

  it('names both roles when both hold privileges', () => {
    const input = introspection({
      tables: [
        table('t', {
          rlsEnabled: false,
          anon: { ...NO_PRIVILEGES, update: true },
          authenticated: SELECT_ONLY,
        }),
      ],
    })
    expect(only(input, 'RR002').detail).toContain('anon and authenticated')
  })

  it('stays silent when no API role has privileges', () => {
    const input = introspection({
      tables: [table('t', { rlsEnabled: false, anon: NO_PRIVILEGES, authenticated: NO_PRIVILEGES })],
    })
    expect(ruleIds(input)).toEqual([])
  })
})

describe('RR003: read policy matches every row', () => {
  const owned = table('t', { ownerColumn: 'user_id' })

  it.each(['SELECT', 'ALL'] as const)('fires for a %s policy on an owned table', (cmd) => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { cmd, qual: 'true', withCheck: 'true' })],
    })
    expect(only(input, 'RR003').detail).toContain('"p"')
  })

  it('fires on a table with sensitive columns and no owner', () => {
    const input = introspection({
      tables: [table('t', { sensitive: ['email'] })],
      policies: [policy('t', { qual: 'true' })],
    })
    expect(ruleIds(input)).toContain('RR003')
  })

  it('ignores a public lookup table with no owner or sensitive columns', () => {
    const input = introspection({ tables: [table('t')], policies: [policy('t', { qual: 'true' })] })
    expect(ruleIds(input)).not.toContain('RR003')
  })

  it('ignores an owner-scoped predicate', () => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { qual: `(user_id = ${WRAPPED_UID})` })],
    })
    expect(ruleIds(input)).not.toContain('RR003')
  })

  it('ignores a policy that only applies to service_role, which bypasses RLS anyway', () => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { roles: ['service_role'], qual: 'true' })],
    })
    expect(ruleIds(input)).not.toContain('RR003')
  })

  it('ignores a restrictive policy, which cannot grant access', () => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { permissive: false, qual: 'true' })],
    })
    expect(ruleIds(input)).not.toContain('RR003')
  })

  it('counts the default PUBLIC role as reachable from the API', () => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { roles: ['public'], qual: 'true' })],
    })
    expect(ruleIds(input)).toContain('RR003')
  })
})

describe('RR004: UPDATE policy without WITH CHECK', () => {
  const t = table('t', { ownerColumn: 'user_id' })

  it.each(['UPDATE', 'ALL'] as const)('fires for a %s policy with USING only', (cmd) => {
    const input = introspection({
      tables: [t],
      policies: [policy('t', { cmd, qual: `(user_id = ${WRAPPED_UID})` })],
    })
    expect(only(input, 'RR004').severity).toBe('medium')
  })

  it('states that Postgres reuses USING, rather than claiming the row can be re-owned', () => {
    const input = introspection({
      tables: [t],
      policies: [policy('t', { cmd: 'UPDATE', qual: `(user_id = ${WRAPPED_UID})` })],
    })
    const finding = only(input, 'RR004')
    expect(finding.detail).toMatch(/reuses USING/i)
    expect(finding.fixHint).toContain('with check ("user_id" = (select auth.uid()))')
  })

  it('stays silent when WITH CHECK is present', () => {
    const input = introspection({
      tables: [t],
      policies: [policy('t', { cmd: 'UPDATE', qual: 'a', withCheck: 'a' })],
    })
    expect(ruleIds(input)).not.toContain('RR004')
  })

  it('ignores SELECT policies', () => {
    const input = introspection({ tables: [t], policies: [policy('t', { qual: 'a' })] })
    expect(ruleIds(input)).not.toContain('RR004')
  })
})

describe('RR005: INSERT policy without an ownership check', () => {
  const owned = table('t', { ownerColumn: 'user_id' })

  it('says any owner can be written when WITH CHECK is true', () => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { cmd: 'INSERT', withCheck: 'true' })],
    })
    expect(only(input, 'RR005').detail).toMatch(/any owner/i)
  })

  it('says inserts are denied when WITH CHECK is absent, since Postgres treats that as deny', () => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { cmd: 'INSERT', withCheck: null })],
    })
    expect(only(input, 'RR005').detail).toMatch(/denies every insert/i)
  })

  it('stays silent on an owner-scoped check', () => {
    const input = introspection({
      tables: [owned],
      policies: [policy('t', { cmd: 'INSERT', withCheck: `(user_id = ${WRAPPED_UID})` })],
    })
    expect(ruleIds(input)).not.toContain('RR005')
  })

  it('ignores tables with no owner column', () => {
    const input = introspection({
      tables: [table('t')],
      policies: [policy('t', { cmd: 'INSERT', withCheck: 'true' })],
    })
    expect(ruleIds(input)).not.toContain('RR005')
  })
})

describe('RR006: views bypassing RLS', () => {
  it('fires for a selectable view without security_invoker', () => {
    const finding = only(introspection({ views: [view('v')] }), 'RR006')
    expect(finding.severity).toBe('high')
    expect(finding.table).toBe('v')
    expect(finding.fixHint).toContain('security_invoker = true')
  })

  it('fires when only authenticated can select', () => {
    const input = introspection({ views: [view('v', { anonSelect: false })] })
    expect(ruleIds(input)).toContain('RR006')
  })

  it('suggests revoking on a materialized view, which has no security_invoker', () => {
    const finding = only(introspection({ views: [view('m', { materialized: true })] }), 'RR006')
    expect(finding.fixHint).toContain('revoke select')
    expect(finding.fixHint).not.toContain('security_invoker')
  })

  it('stays silent with security_invoker', () => {
    expect(ruleIds(introspection({ views: [view('v', { securityInvoker: true })] }))).toEqual([])
  })

  it('stays silent when no API role can select', () => {
    const input = introspection({ views: [view('v', { anonSelect: false, authSelect: false })] })
    expect(ruleIds(input)).toEqual([])
  })
})

describe('RR007: SECURITY DEFINER functions', () => {
  it('is high when anon can execute', () => {
    const finding = only(introspection({ functions: [definerFunction('f', { args: 'q text' })] }), 'RR007')
    expect(finding.severity).toBe('high')
    expect(finding.table).toBeUndefined()
    expect(finding.detail).toContain('f(q text)')
    expect(finding.fixHint).toContain('"public"."f"(q text)')
  })

  it('is medium when only authenticated can execute', () => {
    const input = introspection({ functions: [definerFunction('f', { anonExec: false })] })
    expect(only(input, 'RR007').severity).toBe('medium')
  })

  it('stays silent when no API role can execute', () => {
    const input = introspection({
      functions: [definerFunction('f', { anonExec: false, authExec: false })],
    })
    expect(ruleIds(input)).toEqual([])
  })
})

describe('RR008: bare auth.uid()', () => {
  it.each([
    ['a bare call', '(user_id = auth.uid())', true],
    ['a bare call inside a subquery predicate', '(EXISTS ( SELECT 1 FROM m WHERE (m.u = auth.uid())))', true],
    ['the normalized wrapped form', `(user_id = ${WRAPPED_UID})`, false],
    ['a wrapped form with a cast', '(user_id = ( SELECT (auth.uid())::text AS uid))', false],
    ['one wrapped call next to a bare one', `((a = ${WRAPPED_UID}) OR (b = auth.uid()))`, true],
    ['no auth.uid() at all', 'true', false],
  ])('usesBareAuthUid: %s', (_label, expression, expected) => {
    expect(usesBareAuthUid(expression)).toBe(expected)
  })

  it('checks WITH CHECK as well as USING', () => {
    const input = introspection({
      tables: [table('t')],
      policies: [policy('t', { cmd: 'INSERT', withCheck: '(user_id = auth.uid())' })],
    })
    expect(only(input, 'RR008').severity).toBe('low')
  })

  it('reports each policy once even if both expressions are bare', () => {
    const input = introspection({
      tables: [table('t')],
      policies: [policy('t', { cmd: 'UPDATE', qual: '(a = auth.uid())', withCheck: '(a = auth.uid())' })],
    })
    expect(runStaticRules(input).filter((f) => f.ruleId === 'RR008')).toHaveLength(1)
  })

  it('ignores service_role policies, which are never evaluated', () => {
    const input = introspection({
      tables: [table('t')],
      policies: [policy('t', { roles: ['service_role'], qual: '(a = auth.uid())' })],
    })
    expect(ruleIds(input)).not.toContain('RR008')
  })
})

describe('RR009: unindexed owner column', () => {
  const scoped = policy('t', { qual: `(user_id = ${WRAPPED_UID})` })

  it('fires when a policy uses an unindexed owner column', () => {
    const input = introspection({
      tables: [table('t', { ownerColumn: 'user_id', columns: [column('user_id')] })],
      policies: [scoped],
    })
    expect(only(input, 'RR009').fixHint).toContain('create index on "public"."t" ("user_id")')
  })

  it('stays silent when the column is indexed', () => {
    const input = introspection({
      tables: [table('t', { ownerColumn: 'user_id', columns: [column('user_id', { indexed: true })] })],
      policies: [scoped],
    })
    expect(ruleIds(input)).not.toContain('RR009')
  })

  it('stays silent when no policy uses the column', () => {
    const input = introspection({
      tables: [table('t', { ownerColumn: 'user_id', columns: [column('user_id')] })],
      policies: [policy('t', { qual: '(is_public)' })],
    })
    expect(ruleIds(input)).not.toContain('RR009')
  })

  it('matches whole identifiers, so user_id does not match other_user_id', () => {
    const input = introspection({
      tables: [table('t', { ownerColumn: 'user_id', columns: [column('user_id')] })],
      policies: [policy('t', { qual: `(other_user_id = ${WRAPPED_UID})` })],
    })
    expect(ruleIds(input)).not.toContain('RR009')
  })

  it('reports the table once when several policies use the column', () => {
    const input = introspection({
      tables: [table('t', { ownerColumn: 'user_id', columns: [column('user_id')] })],
      policies: [scoped, { ...scoped, name: 'q', cmd: 'DELETE' }],
    })
    expect(runStaticRules(input).filter((f) => f.ruleId === 'RR009')).toHaveLength(1)
  })
})

describe('RR010: RLS enabled, no policies', () => {
  it('fires when API roles hold privileges', () => {
    expect(only(introspection({ tables: [table('t')] }), 'RR010').severity).toBe('medium')
  })

  it('stays silent when no API role has privileges', () => {
    const input = introspection({
      tables: [table('t', { anon: NO_PRIVILEGES, authenticated: NO_PRIVILEGES })],
    })
    expect(ruleIds(input)).toEqual([])
  })

  it('stays silent when a policy exists', () => {
    const input = introspection({
      tables: [table('t')],
      policies: [policy('t', { qual: `(a = ${WRAPPED_UID})` })],
    })
    expect(ruleIds(input)).not.toContain('RR010')
  })

  it('matches policies on schema as well as table name', () => {
    const input = introspection({
      tables: [table('t', { schema: 'a' })],
      policies: [policy('t', { schema: 'b', qual: 'x' })],
    })
    expect(ruleIds(input)).toContain('RR010')
  })
})

describe('whole schemas', () => {
  it('finds the bugs planted in the CareNote demo target', () => {
    const ids = new Set(ruleIds(CARENOTE))
    for (const id of ['RR001', 'RR003', 'RR004', 'RR005', 'RR006', 'RR007', 'RR008', 'RR009']) {
      expect(ids).toContain(id)
    }
  })

  it('keeps the CareNote invoices table clean, as the demo control', () => {
    expect(runStaticRules(CARENOTE).filter((f) => f.table === 'invoices')).toEqual([])
  })

  it('scores HQ at 100, because HQ must be clean when scanning itself', () => {
    expect(runStaticRules(HQ)).toEqual([])
    expect(scoreFindings(runStaticRules(HQ)).score).toBe(100)
  })

  it('does not flag anon grants on a correctly protected table', () => {
    const input = introspection({
      tables: [table('t', { anon: SELECT_ONLY, authenticated: ALL_PRIVILEGES })],
      policies: [policy('t', { qual: `(a = ${WRAPPED_UID})` })],
    })
    expect(ruleIds(input)).toEqual([])
  })
})
