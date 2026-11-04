import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PIN_NOT_FOUND_WARNING, toReport, type Finding, type ProbeResult } from '@redrow/engine'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli'
import { renderReport } from '../src/render'
import { captureIO, fakeDeps, scanResult } from './helpers'

const PERSONA = {
  anon: 'A stranger (not logged in)',
  anonShort: 'Stranger',
  loggedIn: 'Any logged-in doctor',
  userA: 'Dr. Ana',
  userAOwn: 'Dr. Ana, her own rows',
  others: 'other doctors',
  tables: {},
}

const probe = (table: string, actor: ProbeResult['actor'], action: ProbeResult['action'], outcome: ProbeResult['outcome'], rowCount: number | null): ProbeResult => ({
  schema: 'public',
  table,
  actor,
  action,
  outcome,
  rowCount,
})

const PROBES = [
  probe('patients', 'anon', 'select_all', 'denied', null),
  probe('patients', 'anon', 'update_any', 'denied', null),
  probe('patients', 'anon', 'delete_any', 'denied', null),
  probe('patients', 'anon', 'insert_other', 'denied', null),
  probe('patients', 'user_a', 'select_own', 'allowed', 40),
  probe('patients', 'user_a', 'select_others', 'allowed', 80),
  probe('patients', 'user_a', 'update_other', 'denied', null),
  probe('patients', 'user_a', 'delete_other', 'denied', null),
  probe('patients', 'user_a', 'insert_other', 'denied', null),
]

const finding = (overrides: Partial<Finding>): Finding => ({
  ruleId: 'RR102',
  severity: 'critical',
  schema: 'public',
  table: 'patients',
  title: 'A signed-in user can read other users\' rows',
  detail: 'A signed-in user can read 80 rows of public.patients owned by other users.',
  fixHint: 'create policy ...',
  probe: { actor: 'user_a', action: 'select_others', outcome: 'allowed', rowCount: 80 },
  ...overrides,
})

const LEAKY = scanResult({
  score: 0,
  grade: 'F',
  probes: PROBES,
  findings: [
    finding({}),
    finding({
      ruleId: 'RR101',
      table: 'profiles',
      detail: 'Anyone holding the public anon key can read 3 rows of public.profiles through the API.',
      probe: { actor: 'anon', action: 'select_all', outcome: 'allowed', rowCount: 3 },
    }),
    finding({
      ruleId: 'RR105',
      table: 'appointments',
      detail: 'A signed-in user can insert a row into public.appointments owned by someone else.',
      probe: { actor: 'user_a', action: 'insert_other', outcome: 'allowed', rowCount: null },
    }),
  ],
})

const plain = { color: false, verbose: false }

describe('renderReport with a persona', () => {
  const text = renderReport(toReport(LEAKY), { ...plain, persona: PERSONA })

  it('names the attackers in the matrix headers', () => {
    const header = text.split('\n').find((line) => line.includes('Stranger') && line.includes('Dr. Ana →'))
    expect(header).toContain('Stranger')
    expect(header).toContain('Dr. Ana → other doctors')
    expect(text).not.toContain('anon read')
    expect(text).not.toContain('A others')
  })

  it('keeps every column lined up under its header', () => {
    const lines = text.split('\n')
    const labels = lines.find((line) => line.startsWith('table') && line.includes('read')) as string
    const row = lines.find((line) => line.startsWith('public.patients') && line.includes('✔ 80')) as string
    expect(row.indexOf('✔ 40')).toBe(labels.indexOf('own'))
    expect(row.indexOf('✔ 80')).toBe(labels.indexOf('read', labels.indexOf('own')))
  })

  it('says who did what in each finding', () => {
    expect(text).toContain("Dr. Ana → read other doctors' rows (allowed, 80 rows)")
    expect(text).toContain('Stranger → read rows (allowed, 3 rows)')
    expect(text).toContain('Dr. Ana → add rows as other doctors (allowed)')
    expect(text).not.toContain('user_a:')
    expect(text).not.toContain('anon:')
  })

  it('puts the impact in the same words', () => {
    expect(text).toContain('Dr. Ana can read 80 rows of public.patients owned by other doctors.')
    expect(text).toContain('A stranger (not logged in) can read 3 rows of public.profiles through the API.')
    expect(text).toContain('Dr. Ana can insert a row into public.appointments owned by other doctors.')
    expect(text).not.toContain('signed-in user')
    expect(text).not.toContain('anon key')
  })

  it('translates the phrase mid-sentence too', () => {
    const rlsOff = scanResult({
      probes: PROBES,
      findings: [
        finding({
          ruleId: 'RR001',
          table: 'profiles',
          detail: 'RLS is off and anon can SELECT public.profiles, so anyone holding the public anon key can read it through the API.',
          probe: undefined,
        } as Partial<Finding>),
      ],
    })
    const words = renderReport(toReport(rlsOff), { ...plain, persona: PERSONA })
    expect(words).toContain('so a stranger (not logged in) can read it through the API.')
  })

  it('uses the words in the verbose probe list too', () => {
    const verbose = renderReport(toReport(LEAKY), { color: false, verbose: true, persona: PERSONA })
    expect(verbose).toContain("Dr. Ana → read other doctors' rows  allowed  80 rows")
    expect(verbose).not.toContain('user_a:')
  })

  it('cannot be used to smuggle terminal escapes in through a label', () => {
    const hostile = renderReport(toReport(LEAKY), { ...plain, persona: { ...PERSONA, userA: 'Dr.\u001b]0;pwned\u0007 Ana' } })
    expect(hostile).not.toContain('\u001b')
  })
})

describe('renderReport with no persona', () => {
  it('keeps the generic labels', () => {
    const text = renderReport(toReport(LEAKY), plain)
    expect(text).toContain('anon read')
    expect(text).toContain('user_a:select_others')
    expect(text).toContain('A signed-in user can read 80 rows')
    expect(text).not.toContain('Dr. Ana')
  })
})

describe('redrow scan on a target with a persona', () => {
  const DB = 'postgres://u:s3cret@localhost:5432/app_test'
  const EMAIL = 'dr.ana@carenote.test'

  const configured = (key: string): string => {
    const cwd = mkdtempSync(join(tmpdir(), 'redrow-persona-'))
    const config = { actors: { [key]: { userA: EMAIL } }, personas: { [key]: PERSONA } }
    writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify(config))
    return cwd
  }

  it('finds them by host/login with no flags, pins the attacker and uses the labels', async () => {
    const deps = fakeDeps(LEAKY)
    const io = captureIO({ cwd: configured('localhost/u') })
    await run(['scan', '--db', DB], io, deps)
    expect(deps.calls.scanOptions[0]).toMatchObject({ userAEmail: EMAIL })
    expect(io.out()).toContain('Dr. Ana')
  })

  it('leaves any other login on the same host generic, so nobody else gets these labels', async () => {
    const deps = fakeDeps(LEAKY)
    const io = captureIO({ cwd: configured('localhost/someone-else') })
    await run(['scan', '--db', DB], io, deps)
    expect(deps.calls.scanOptions[0]).not.toHaveProperty('userAEmail')
    expect(io.out()).not.toContain('Dr. Ana')
  })

  it('still finds them by --project', async () => {
    const deps = fakeDeps(LEAKY)
    const io = captureIO({ cwd: configured('CareNote demo') })
    await run(['scan', '--db', DB, '--project', 'CareNote demo'], io, deps)
    expect(deps.calls.scanOptions[0]).toMatchObject({ userAEmail: EMAIL })
    expect(io.out()).toContain('Dr. Ana')
  })

  // A random user must not be called Dr. Ana just because the config says so.
  it('falls back to generic labels when the pinned user was not found', async () => {
    const fellBack = scanResult({ ...LEAKY, warnings: [PIN_NOT_FOUND_WARNING] })
    const io = captureIO({ cwd: configured('localhost/u') })
    await run(['scan', '--db', DB], io, fakeDeps(fellBack))
    expect(io.out()).not.toContain('Dr. Ana')
    expect(io.out()).toContain('user_a:select_others')
    expect(io.out()).toContain(PIN_NOT_FOUND_WARNING)
  })

  it('does not label anyone Dr. Ana when only the persona is set, with nobody pinned', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'redrow-persona-'))
    writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ personas: { 'localhost/u': PERSONA } }))
    const io = captureIO({ cwd })
    await run(['scan', '--db', DB], io, fakeDeps(LEAKY))
    expect(io.out()).not.toContain('Dr. Ana')
  })

  it('leaves the JSON contract alone', async () => {
    const io = captureIO({ cwd: configured('localhost/u') })
    await run(['scan', '--db', DB, '--json'], io, fakeDeps(LEAKY))
    expect(io.out()).not.toContain('Dr. Ana')
    const probes = (JSON.parse(io.out()) as { findings: { probe: string }[] }).findings.map((f) => f.probe)
    expect(probes).toContain('user_a:select_others')
  })
})
