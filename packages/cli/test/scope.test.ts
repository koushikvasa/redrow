import type { Introspection, PolicyInfo, Report, ReportFinding, TableInfo } from '@redrow/engine'
import { describe, expect, it } from 'vitest'
import { MigrationError } from '../src/fix/migration'
import { assertInScope } from '../src/fix/scope'

const table = (schema: string, name: string): TableInfo =>
  ({ oid: 1, schema, table: name, rlsEnabled: true, rlsForced: false, columns: [], ownerColumn: 'user_id', sensitive: [] }) as unknown as TableInfo

const policy = (name: string, permissive: boolean): PolicyInfo =>
  ({ schema: 'public', table: 'patients', name, permissive, roles: ['authenticated'], cmd: 'ALL', qual: null, withCheck: null }) as unknown as PolicyInfo

const catalog: Introspection = {
  tables: [table('public', 'patients'), table('public', 'other'), table('public', 'MixedCase')],
  policies: [policy('owner', true), policy('Only Clinic', false)],
  views: [{ schema: 'public', view: 'summary', materialized: false }],
  functions: [{ schema: 'public', name: 'search', args: 'q text' }],
} as unknown as Introspection

const finding = (id: string, name: string | null, description = 'x'): ReportFinding =>
  ({ id, severity: 'high', table: name, policy: null, probe: null, description, remediation: 'x', evidence: { kind: 'catalog', schema: 'public' } }) as ReportFinding

const report = {
  findings: [
    finding('RR003', 'patients'),
    finding('RR003', 'MixedCase'),
    finding('RR006', 'summary'),
    finding('RR007', null, 'public.search(q text) is SECURITY DEFINER'),
    { ...finding('RR101', 'other', 'declared'), severity: 'info' as const },
  ],
} as unknown as Report

const check = (statement: string): void => assertInScope([statement], report, catalog)

describe('assertInScope', () => {
  it.each([
    'alter table public.patients enable row level security',
    'alter table only "public"."patients" force row level security',
    'alter table public."MixedCase" enable row level security',
    'create policy n on public.patients for all to authenticated using (a) with check (a)',
    'alter policy owner on public.patients using (a)',
    'drop policy if exists "owner" on public.patients',
    'create index if not exists i on PUBLIC.PATIENTS (a)',
    'alter view public.summary set (security_invoker = true)',
    'revoke execute on function public.search(q text) from anon, authenticated, public',
    'revoke all on table public.patients from anon',
  ])('allows a statement on a reported object: %s', (statement) => {
    expect(() => check(statement)).not.toThrow()
  })

  it.each([
    ['a table with no findings', 'alter policy owner on public.unrelated using (a)'],
    ['a declared table, whose info finding is not a fix', 'create index on public.other (a)'],
    ['a function nobody reported', 'revoke execute on function auth.uid() from authenticated'],
    ['a table with the same name in another schema', 'revoke all on private.patients from anon'],
    ['the wrong case of a quoted name', 'alter table public."PATIENTS" enable row level security'],
    ['an unquoted name that folds to something else', 'alter table public.MixedCase enable row level security'],
    ['a name with no schema, which search_path decides', 'alter table patients enable row level security'],
  ])('rejects %s', (_label, statement) => {
    expect(() => check(statement)).toThrow(MigrationError)
  })

  // A restrictive policy narrows what others allow, so loosening it opens rows up.
  it.each([
    'drop policy "Only Clinic" on public.patients',
    'alter policy "Only Clinic" on public.patients using (true or x)',
  ])('refuses to loosen a restrictive policy: %s', (statement) => {
    expect(() => check(statement)).toThrow(/restrictive/i)
  })

  it('compares names as Postgres does, which cuts them to 63 bytes', () => {
    const name = 'r'.repeat(63)
    const longCatalog = { ...catalog, policies: [policy(name, false)] } as Introspection
    const statement = `drop policy "${name}zzz" on public.patients`
    expect(() => assertInScope([statement], report, longCatalog)).toThrow(/restrictive/i)
  })

  it('never cuts a name in the middle of a multi-byte character', () => {
    const name = `${'r'.repeat(62)}`
    const longCatalog = { ...catalog, policies: [policy(name, false)] } as Introspection
    expect(() => assertInScope([`drop policy "${name}é" on public.patients`], report, longCatalog)).toThrow(/restrictive/i)
  })

  it('names the object it refused', () => {
    expect(() => check('revoke all on public.unrelated from anon')).toThrow(/public\.unrelated/)
  })
})
