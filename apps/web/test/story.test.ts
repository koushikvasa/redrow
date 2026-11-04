import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { columnGroups } from '../lib/matrix'
import { GENERIC_PERSONA, personaFor, type Persona } from '../lib/personas'
import { blockedCount, groupFindings, plainHeadline, replayLines, replaySignature } from '../lib/story'
import type { FindingRow, ProbeRow, Severity } from '../lib/types'

const DOCTORS: Persona = {
  anon: 'A stranger (not logged in)',
  anonShort: 'Stranger',
  loggedIn: 'Any logged-in doctor',
  userA: 'Dr. Ana',
  userAOwn: 'Dr. Ana, her own rows',
  others: 'other doctors',
  tables: {
    patients: { noun: 'patients' },
    visit_notes: { noun: 'notes' },
    appointments: { noun: 'appointments' },
    profiles: { noun: 'profiles', strangerNoun: 'clinician profiles', strangerReadNoun: 'clinician emails' },
  },
}

const probe = (table_name: string, actor: string, action: string, outcome: string, row_count: number | null): ProbeRow => ({
  table_name,
  actor,
  action,
  outcome,
  row_count,
})

let nextId = 0
const finding = (rule_id: string, severity: Severity, table_name: string | null, overrides: Partial<FindingRow> = {}): FindingRow => {
  nextId += 1
  return {
    id: `f${nextId}`,
    rule_id,
    severity,
    schema_name: 'public',
    table_name,
    title: `Title of ${rule_id}`,
    detail: `Detail of ${rule_id}`,
    rows_exposed: null,
    fix_hint: `Fix for ${rule_id}`,
    ...overrides,
  }
}

const READ_80 = probe('patients', 'user_a', 'select_others', 'allowed', 80)
const DELETE_240 = probe('visit_notes', 'user_a', 'delete_other', 'allowed', 240)
const STRANGER_3 = probe('profiles', 'anon', 'select_all', 'allowed', 3)
const LEAK_FINDINGS = [
  finding('RR102', 'critical', 'patients'),
  finding('RR104', 'critical', 'visit_notes'),
  finding('RR101', 'critical', 'profiles'),
]

describe('plainHeadline', () => {
  it('says what the two worst attacks did, in the persona, one actor in one sentence', () => {
    expect(plainHeadline([READ_80, DELETE_240], LEAK_FINDINGS, DOCTORS)).toBe(
      "Any logged-in doctor can read 80 of other doctors' patients and delete 240 of other doctors' notes.",
    )
  })

  it('uses one sentence per actor', () => {
    const headline = plainHeadline([READ_80, STRANGER_3], LEAK_FINDINGS, DOCTORS)
    expect(headline).toBe("Any logged-in doctor can read 80 of other doctors' patients. A stranger (not logged in) can read 3 clinician emails.")
  })

  it('picks by severity before row count', () => {
    const findings = [finding('RR102', 'critical', 'patients'), finding('RR104', 'medium', 'visit_notes')]
    const big = probe('visit_notes', 'user_a', 'delete_other', 'allowed', 9000)
    const headline = plainHeadline([READ_80, big, STRANGER_3], [...findings, finding('RR101', 'high', 'profiles')], DOCTORS)
    expect(headline).toContain('80')
    expect(headline).toContain('clinician emails')
    expect(headline).not.toContain('9000')
  })

  it('never claims an attack no finding backs', () => {
    expect(plainHeadline([READ_80], [], DOCTORS)).toBe('No leaks proven.')
  })

  it('handles an insert with no row count', () => {
    const insert = probe('appointments', 'user_a', 'insert_other', 'allowed', null)
    expect(plainHeadline([insert], [finding('RR105', 'critical', 'appointments')], DOCTORS)).toBe(
      'Any logged-in doctor can add appointments as other doctors.',
    )
  })

  it('falls back to generic words for a project with no persona', () => {
    expect(plainHeadline([probe('visit_notes', 'user_a', 'select_others', 'allowed', 5)], [finding('RR102', 'high', 'visit_notes')], GENERIC_PERSONA)).toBe(
      "Any signed-in user can read 5 of other users' visit notes.",
    )
  })

  it('states a problem the probes could not show as a count', () => {
    expect(plainHeadline([], [finding('RR007', 'high', null, { title: 'SECURITY DEFINER function callable from the API' })], DOCTORS)).toBe(
      'SECURITY DEFINER function callable from the API.',
    )
  })

  it('is not alarmed by low findings or a declared board', () => {
    const findings = [finding('RR008', 'low', 'patients'), finding('RR101', 'info', 'projects')]
    expect(plainHeadline([], findings, DOCTORS)).toBe('No leaks proven.')
  })
})

describe('replayLines', () => {
  it('writes each attack as actor, action and result, worst first', () => {
    const lines = replayLines([STRANGER_3, READ_80, DELETE_240], LEAK_FINDINGS, DOCTORS)
    expect(lines.map((l) => `${l.action} ${l.result}`)).toEqual([
      "Dr. Ana → delete other doctors' notes → 240 rows",
      "Dr. Ana → read other doctors' patients → 80 rows",
      'Stranger → read clinician emails → 3 rows',
    ])
  })

  it('stops at five', () => {
    const tables = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const many = tables.map((t) => probe(t, 'anon', 'select_all', 'allowed', 1))
    expect(replayLines(many, tables.map((t) => finding('RR101', 'high', t)), DOCTORS)).toHaveLength(5)
  })

  it('leaves out reading your own rows, and anything no finding backs', () => {
    const own = probe('patients', 'user_a', 'select_own', 'allowed', 40)
    const board = probe('projects', 'anon', 'select_all', 'allowed', 2)
    expect(replayLines([own, board], [], DOCTORS)).toEqual([])
  })

  it('says one row, and allowed when there is no count', () => {
    const lines = replayLines(
      [probe('profiles', 'user_a', 'update_other', 'allowed', 1), probe('appointments', 'user_a', 'insert_other', 'allowed', null)],
      [finding('RR103', 'critical', 'profiles'), finding('RR105', 'high', 'appointments')],
      DOCTORS,
    )
    expect(lines.map((l) => l.result)).toEqual(['1 row', 'allowed'])
    expect(lines[1]?.action).toBe('Dr. Ana → add appointments as other doctors →')
  })
})

describe('replaySignature', () => {
  const base = [READ_80, probe('t', 'anon', 'select_all', 'denied', null)]

  it('stays the same between sweeps when nothing changed', () => {
    expect(replaySignature([...base].reverse(), 0)).toBe(replaySignature(base, 0))
  })

  it('ignores row counts, since the set of attacks is the same', () => {
    const moreRows = [probe('patients', 'user_a', 'select_others', 'allowed', 81), base[1] as ProbeRow]
    expect(replaySignature(moreRows, 0)).toBe(replaySignature(base, 0))
  })

  it('changes when the score changes', () => {
    expect(replaySignature(base, 40)).not.toBe(replaySignature(base, 0))
  })

  it('changes when an attack starts or stops getting through', () => {
    expect(replaySignature([...base, DELETE_240], 0)).not.toBe(replaySignature(base, 0))
    expect(replaySignature([base[1] as ProbeRow], 0)).not.toBe(replaySignature(base, 0))
  })

  it('ignores reading your own rows and blocked attempts, which are not attacks that got through', () => {
    const own = probe('patients', 'user_a', 'select_own', 'allowed', 40)
    const blocked = probe('z', 'anon', 'delete_any', 'denied', null)
    expect(replaySignature([...base, own, blocked], 0)).toBe(replaySignature(base, 0))
  })
})

describe('blockedCount', () => {
  it('counts denied probes only', () => {
    expect(blockedCount([READ_80, probe('t', 'anon', 'select_all', 'denied', null), probe('t', 'anon', 'delete_any', 'inconclusive', null)])).toBe(1)
  })
})

describe('groupFindings', () => {
  const findings = [
    finding('RR001', 'critical', 'profiles'),
    finding('RR101', 'critical', 'profiles'),
    finding('RR106', 'high', 'profiles'),
    finding('RR102', 'high', 'patients'),
    finding('RR006', 'high', 'patient_summary'),
    finding('RR007', 'high', null),
    finding('RR008', 'low', 'patients'),
    finding('RR009', 'low', 'patients'),
  ]
  const { cards, hints } = groupFindings(findings, DOCTORS)

  it('makes one card per table, worst first', () => {
    expect(cards[0]).toMatchObject({ title: 'profiles', worst: 'critical', problems: 3 })
    expect(cards.map((c) => c.title)).toEqual(['profiles', 'patient_summary', 'patients', 'Functions'])
  })

  it('moves every low finding to the hints', () => {
    expect(hints.map((f) => f.rule_id)).toEqual(['RR008', 'RR009'])
    expect(cards.flatMap((c) => c.findings).some((f) => f.severity === 'low')).toBe(false)
  })

  it('leads a card with what it means', () => {
    const phraseOf = (title: string) => cards.find((c) => c.title === title)?.phrase
    expect(phraseOf('profiles')).toBe('wide open')
    expect(phraseOf('patients')).toBe('open to other doctors')
    expect(phraseOf('patient_summary')).toBe('bypasses RLS')
  })

  it('says open to anyone when a stranger got in and RLS is on', () => {
    const { cards: only } = groupFindings([finding('RR106', 'high', 'visit_notes')], DOCTORS)
    expect(only[0]?.phrase).toBe('open to anyone')
  })

  it('keeps a declared table apart, with no problem count', () => {
    const { cards: declared } = groupFindings([finding('RR101', 'info', 'projects')], DOCTORS)
    expect(declared[0]).toMatchObject({ title: 'projects', worst: 'info', phrase: 'public on purpose', problems: 0 })
  })

  it('orders a card by severity, so its worst finding comes first', () => {
    const { cards: one } = groupFindings([finding('RR106', 'high', 't'), finding('RR001', 'critical', 't')], DOCTORS)
    expect(one[0]?.findings.map((f) => f.rule_id)).toEqual(['RR001', 'RR106'])
  })
})

describe('columnGroups', () => {
  it('names the matrix headers in the persona', () => {
    expect(columnGroups(DOCTORS).map((g) => g.label)).toEqual(['Stranger', 'Dr. Ana, her own rows', "Dr. Ana → other doctors' rows"])
  })

  it('falls back to generic labels', () => {
    expect(columnGroups(GENERIC_PERSONA).map((g) => g.label)).toEqual(['Anon', 'User A, own rows', "User A → other users' rows"])
  })
})

describe('personaFor', () => {
  it('finds the CareNote persona, and falls back for anything else', () => {
    expect(personaFor('CareNote demo').userA).toBe('Dr. Ana')
    expect(personaFor('Some other project')).toBe(GENERIC_PERSONA)
  })

  // Vercel uploads only apps/web, so it holds a copy. This fails if someone edits one and not the other.
  it('matches the personas in hq/redrow.config.json. Run npm run sync:web if it does not', () => {
    const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
    const config = read('../../../hq/redrow.config.json') as { personas: unknown }
    expect(read('../data/personas.json')).toEqual(config.personas)
  })
})
