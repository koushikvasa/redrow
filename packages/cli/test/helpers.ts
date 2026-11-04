import type { Report, ReportFinding, ScanResult } from '@redrow/engine'
import type { Sql } from 'postgres'
import type { CliDeps, CliIO } from '../src/cli'
import type { ConnectionTarget } from '../src/connection'

export interface CapturedIO extends CliIO {
  readonly out: () => string
  readonly err: () => string
}

export function captureIO(overrides: Partial<CliIO> = {}): CapturedIO {
  let stdout = ''
  let stderr = ''
  return {
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    env: {},
    cwd: process.cwd(),
    colorSupported: false,
    spinner: false,
    ...overrides,
    out: () => stdout,
    err: () => stderr,
  }
}

const finding = (overrides: Partial<ScanResult['findings'][number]> = {}): ScanResult['findings'][number] => ({
  ruleId: 'RR008',
  severity: 'low',
  schema: 'public',
  table: 't',
  title: 'title',
  detail: 'detail',
  fixHint: 'hint',
  ...overrides,
})

export const scanResult = (overrides: Partial<ScanResult> = {}): ScanResult => ({
  engineVersion: '0.1.0',
  startedAt: '2026-11-04T12:00:00.000Z',
  durationMs: 1500,
  target: { host: 'localhost', database: 'app_test', schemas: ['public'] },
  score: 100,
  grade: 'A',
  counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  tables: [],
  findings: [],
  probes: [],
  actors: { userA: 'a', userB: 'b' },
  warnings: [],
  ...overrides,
})

export const resultWith = (severity: 'critical' | 'high' | 'medium' | 'low' | 'info'): ScanResult =>
  scanResult({
    findings: [finding({ severity })],
    counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0, [severity]: 1 },
  })

export interface FakeDeps extends CliDeps {
  readonly calls: {
    connect: ConnectionTarget[]
    scanOptions: unknown[]
    ended: number
  }
}

export function fakeDeps(result: ScanResult | Error = scanResult()): FakeDeps {
  const calls: FakeDeps['calls'] = { connect: [], scanOptions: [], ended: 0 }
  return {
    calls,
    connect: (target) => {
      calls.connect.push(target)
      return {
        sql: {} as Sql,
        end: async () => {
          calls.ended += 1
        },
      }
    },
    scan: async (_sql, options) => {
      calls.scanOptions.push(options)
      if (result instanceof Error) throw result
      return result
    },
  }
}

const reportFinding = (overrides: Partial<ReportFinding>): ReportFinding => ({
  id: 'RR008',
  severity: 'low',
  table: 't',
  policy: null,
  probe: null,
  description: 'description',
  evidence: { kind: 'catalog', schema: 'public' },
  remediation: 'remediation',
  ...overrides,
})

const emptySummary: Report['summary'] = {
  total: 0,
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  score: 100,
  grade: 'A',
  tablesScanned: 3,
  probesRun: 12,
  durationMs: 1234,
  probes: [],
  inconclusive: 0,
  warnings: [],
}

const reportBase: Report = {
  version: 1,
  scannedAt: '2026-11-04T12:00:00.000Z',
  database: { host: 'localhost', name: 'app_test', schemas: ['public'] },
  findings: [],
  summary: emptySummary,
}

export const EMPTY_REPORT: Report = reportBase

const leakFinding = reportFinding({
  id: 'RR102',
  severity: 'critical',
  table: 'patients',
  policy: 'Authenticated users can view patients',
  probe: 'user_a:select_others',
  description: 'A signed-in user can read 80 rows of public.patients owned by other users.',
  evidence: {
    kind: 'probe',
    schema: 'public',
    actor: 'user_a',
    action: 'select_others',
    outcome: 'allowed',
    rowCount: 80,
  },
  remediation: 'create policy "owner_read" on "public"."patients" for select to authenticated using ("clinician_id" = (select auth.uid()));',
})

export const CRITICAL_ONLY_REPORT: Report = {
  ...reportBase,
  findings: [leakFinding],
  summary: {
    ...emptySummary,
    total: 1,
    bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
    score: 75,
    grade: 'D',
  },
}

/** HQ's self-scan: nothing wrong, and one exposure the project declared on purpose. */
export const DECLARED_ONLY_REPORT: Report = {
  ...reportBase,
  findings: [
    reportFinding({
      id: 'RR101',
      severity: 'info',
      table: 'projects',
      policy: 'projects_read',
      probe: 'anon:select_all',
      description: 'Declared exposure: Anyone holding the public anon key can read 2 rows of public.projects through the API.',
      evidence: { kind: 'probe', schema: 'public', actor: 'anon', action: 'select_all', outcome: 'allowed', rowCount: 2 },
      remediation: 'None needed while this table is meant to be public. If it is not, remove it from publicTables.',
    }),
  ],
  summary: {
    ...emptySummary,
    total: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 1 },
  },
}

export const MIXED_REPORT: Report = {
  ...reportBase,
  findings: [
    leakFinding,
    reportFinding({
      id: 'RR007',
      severity: 'high',
      table: null,
      description: 'public.search_patients(q text) runs with its owner\'s rights, skipping RLS, and anon can call it through the API.',
      remediation: 'revoke execute on function "public"."search_patients"(q text) from public, anon, authenticated;',
    }),
    reportFinding({
      id: 'RR004',
      severity: 'medium',
      table: 'visit_notes',
      policy: 'Authors update own notes',
      description: 'Policy "Authors update own notes" has no WITH CHECK.',
      remediation: 'alter policy "Authors update own notes" on "public"."visit_notes" with check ("author_id" = (select auth.uid()));',
    }),
    reportFinding({
      id: 'RR009',
      severity: 'low',
      table: 'visit_notes',
      description: 'public.visit_notes.author_id is used in a policy but no index leads with it.',
      remediation: 'create index on "public"."visit_notes" ("author_id");',
    }),
  ],
  summary: {
    ...emptySummary,
    total: 4,
    bySeverity: { critical: 1, high: 1, medium: 1, low: 1, info: 0 },
    score: 60,
    grade: 'D',
    inconclusive: 1,
    probes: [
      { schema: 'public', table: 'patients', actor: 'anon', action: 'select_all', outcome: 'denied', rowCount: 0 },
      { schema: 'public', table: 'patients', actor: 'user_a', action: 'select_others', outcome: 'allowed', rowCount: 80 },
      { schema: 'public', table: 'patients', actor: 'user_a', action: 'insert_other', outcome: 'inconclusive', rowCount: null },
      { schema: 'public', table: 'invoices', actor: 'anon', action: 'select_all', outcome: 'denied', rowCount: 0 },
      { schema: 'public', table: 'invoices', actor: 'user_a', action: 'select_others', outcome: 'denied', rowCount: 0 },
    ],
  },
}
