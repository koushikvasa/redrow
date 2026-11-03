import { describe, expect, it } from 'vitest'
import { RULES, makeFinding, type RuleId } from '../src/rules'

// The severity column of the two tables in ENGINE.md §2.
const SPEC_SEVERITIES: Record<RuleId, string> = {
  RR001: 'critical',
  RR002: 'high',
  RR003: 'high',
  RR004: 'medium',
  RR005: 'medium',
  RR006: 'high',
  RR007: 'high',
  RR008: 'low',
  RR009: 'low',
  RR010: 'medium',
  RR101: 'critical',
  RR102: 'critical',
  RR103: 'critical',
  RR104: 'critical',
  RR105: 'high',
  RR106: 'high',
}

describe('rule catalog', () => {
  it('defines exactly RR001-RR010 and RR101-RR106', () => {
    expect(Object.keys(RULES).sort()).toEqual(Object.keys(SPEC_SEVERITIES).sort())
  })

  it.each(Object.entries(SPEC_SEVERITIES))('%s has severity %s', (id, severity) => {
    expect(RULES[id as RuleId].severity).toBe(severity)
  })

  it.each(Object.keys(RULES))('%s has a title and a hint with or without context', (id) => {
    const rule = RULES[id as RuleId]
    expect(rule.title.length).toBeGreaterThan(0)
    expect(rule.fixHint({ schema: 'public' }).length).toBeGreaterThan(0)
    expect(
      rule.fixHint({
        schema: 'public',
        table: 't',
        column: 'c',
        policy: 'p',
        functionName: 'f',
        functionArgs: 'a int',
      }).length,
    ).toBeGreaterThan(0)
  })
})

describe('fix hints', () => {
  it('quotes identifiers so mixed-case names stay valid when pasted', () => {
    const finding = makeFinding('RR001', { schema: 'public', table: 'User', column: 'ownerId' }, 'd')
    expect(finding.fixHint).toContain('alter table "public"."User" enable row level security')
    expect(finding.fixHint).toContain('"ownerId" = (select auth.uid())')
  })

  it('escapes embedded quotes in identifiers', () => {
    const finding = makeFinding('RR009', { schema: 'public', table: 'a"b', column: 'c' }, 'd')
    expect(finding.fixHint).toContain('"a""b"')
  })

  it.each(['RR007', 'RR010', 'RR102'] as const)(
    '%s keeps its prose in a SQL comment, so the hint can be pasted and run as is',
    (ruleId) => {
      const { fixHint } = makeFinding(ruleId, { schema: 'public', table: 't', functionName: 'f' }, 'd')
      expect(fixHint).toMatch(/; -- /)
      expect(fixHint.split('; -- ')).toHaveLength(2)
    },
  )

  it('uses a placeholder when the table has no known owner column', () => {
    const finding = makeFinding('RR003', { schema: 'public', table: 't', policy: 'p' }, 'd')
    expect(finding.fixHint).toContain('<owner_column> = (select auth.uid())')
  })
})

describe('makeFinding', () => {
  it('fills title and default severity from the catalog', () => {
    expect(makeFinding('RR006', { schema: 's', table: 'v' }, 'why')).toMatchObject({
      ruleId: 'RR006',
      severity: 'high',
      schema: 's',
      table: 'v',
      title: RULES.RR006.title,
      detail: 'why',
    })
  })

  it('lets a rule override its default severity', () => {
    expect(makeFinding('RR007', { schema: 's' }, 'why', 'medium').severity).toBe('medium')
  })

  it('leaves table out for schema-level findings, so the JSON has no null key', () => {
    expect(makeFinding('RR007', { schema: 's' }, 'why')).not.toHaveProperty('table')
  })
})
