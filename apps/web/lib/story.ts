import { COLUMNS, backingRules, buildMatrix, type Verb } from './matrix'
import { possessive, type Persona, type TableWords } from './personas'
import type { FindingRow, ProbeRow, Severity } from './types'

/**
 * The plain-English story. Everything here comes from cells of the leak matrix that a counted
 * finding backs, so the words can't claim more than the probes proved.
 */

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info']
const rank = (severity: Severity): number => SEVERITY_ORDER.indexOf(severity)
const HEADLINE_FACTS = 2
const REPLAY_LINES = 5

interface LeakFact {
  readonly table: string
  readonly isStranger: boolean
  readonly verb: Verb
  readonly count: number | null
  readonly severity: Severity
}

function factsFrom(probes: readonly ProbeRow[], findings: readonly FindingRow[]): LeakFact[] {
  const facts = buildMatrix(probes, findings).flatMap((row) =>
    row.cells.flatMap((cell): LeakFact[] => {
      const column = COLUMNS.find((c) => c.id === cell.column)
      if (cell.state !== 'leak' || column === undefined) return []
      const rules = backingRules(column)
      const backing = findings.filter((f) => f.table_name === row.table && f.severity !== 'info' && rules.includes(f.rule_id))
      const severity = backing.map((f) => f.severity).sort((a, b) => rank(a) - rank(b))[0] ?? 'low'
      return [{ table: row.table, isStranger: column.group === 'anon', verb: column.verb, count: cell.count, severity }]
    }),
  )
  return facts.sort((a, b) => rank(a.severity) - rank(b.severity) || (b.count ?? -1) - (a.count ?? -1))
}

const wordsFor = (table: string, persona: Persona): TableWords => persona.tables[table] ?? { noun: table.replaceAll('_', ' ') }

function strangerNoun(fact: LeakFact, persona: Persona): string {
  const words = wordsFor(fact.table, persona)
  const forRead = fact.verb === 'read' ? words.strangerReadNoun : undefined
  return forRead ?? words.strangerNoun ?? words.noun
}

/** "read 80 of other doctors' patients" */
function clause(fact: LeakFact, persona: Persona): string {
  if (fact.isStranger) {
    const noun = strangerNoun(fact, persona)
    return fact.count === null ? `${fact.verb} ${noun}` : `${fact.verb} ${fact.count} ${noun}`
  }
  const { noun } = wordsFor(fact.table, persona)
  if (fact.verb === 'add') return `add ${noun} as ${persona.others}`
  const whose = possessive(persona.others)
  return fact.count === null ? `${fact.verb} ${whose} ${noun}` : `${fact.verb} ${fact.count} of ${whose} ${noun}`
}

/** "Dr. Ana → read other doctors' patients →" */
function replayAction(fact: LeakFact, persona: Persona): string {
  if (fact.isStranger) return `${persona.anonShort} → ${fact.verb} ${strangerNoun(fact, persona)} →`
  const { noun } = wordsFor(fact.table, persona)
  const what = fact.verb === 'add' ? `add ${noun} as ${persona.others}` : `${fact.verb} ${possessive(persona.others)} ${noun}`
  return `${persona.userA} → ${what} →`
}

const sentence = (actor: string, facts: readonly LeakFact[], persona: Persona): string => {
  // Reads first: "can read X and delete Y" is how anyone would say it.
  const ordered = [...facts].sort((a, b) => Number(b.verb === 'read') - Number(a.verb === 'read'))
  return `${actor} can ${ordered.map((f) => clause(f, persona)).join(' and ')}.`
}

/** One or two plain sentences from the worst attacks that got through. */
export function plainHeadline(probes: readonly ProbeRow[], findings: readonly FindingRow[], persona: Persona): string {
  const worst = factsFrom(probes, findings).slice(0, HEADLINE_FACTS)
  if (worst.length > 0) {
    const firstIsStranger = (worst[0] as LeakFact).isStranger
    const sameActor = worst.filter((f) => f.isStranger === firstIsStranger)
    const otherActor = worst.filter((f) => f.isStranger !== firstIsStranger)
    const actorOf = (isStranger: boolean): string => (isStranger ? persona.anon : persona.loggedIn)
    const parts = [sentence(actorOf(firstIsStranger), sameActor, persona)]
    if (otherActor.length > 0) parts.push(sentence(actorOf(!firstIsStranger), otherActor, persona))
    return parts.join(' ')
  }
  const serious = findings
    .filter((f) => f.severity !== 'info' && f.severity !== 'low')
    .sort((a, b) => rank(a.severity) - rank(b.severity))[0]
  return serious === undefined ? 'No leaks proven.' : `${serious.title}.`
}

export interface ReplayLine {
  readonly action: string
  readonly result: string
}

const resultText = (count: number | null): string => {
  if (count === null) return 'allowed'
  return count === 1 ? '1 row' : `${count} rows`
}

export function replayLines(probes: readonly ProbeRow[], findings: readonly FindingRow[], persona: Persona): ReplayLine[] {
  return factsFrom(probes, findings)
    .slice(0, REPLAY_LINES)
    .map((fact) => ({ action: replayAction(fact, persona), result: resultText(fact.count) }))
}

export const blockedCount = (probes: readonly ProbeRow[]): number => probes.filter((p) => p.outcome === 'denied').length

export interface FindingCard {
  readonly key: string
  readonly title: string
  readonly phrase: string
  readonly worst: Severity
  /** Zero for a declared table: being public on purpose isn't a problem. */
  readonly problems: number
  readonly findings: readonly FindingRow[]
}

function phraseFor(findings: readonly FindingRow[], persona: Persona): string {
  const ids = new Set(findings.map((f) => f.rule_id))
  const hasAny = (...rules: readonly string[]): boolean => rules.some((rule) => ids.has(rule))
  if (hasAny('RR001', 'RR002')) return 'wide open'
  if (hasAny('RR101', 'RR106')) return 'open to anyone'
  if (hasAny('RR102', 'RR103', 'RR104', 'RR105', 'RR003')) return `open to ${persona.others}`
  if (hasAny('RR006')) return 'bypasses RLS'
  if (hasAny('RR007')) return 'callable by anyone, and skips RLS'
  if (hasAny('RR004', 'RR005')) return 'weak write rules'
  if (hasAny('RR010')) return 'locked, with no policies'
  return 'needs a fix'
}

const bySeverityThenRule = (a: FindingRow, b: FindingRow): number =>
  rank(a.severity) - rank(b.severity) || a.rule_id.localeCompare(b.rule_id) || a.detail.localeCompare(b.detail)

function toCard(key: string, table: string | null, findings: readonly FindingRow[], persona: Persona): FindingCard {
  const ordered = [...findings].sort(bySeverityThenRule)
  const worst = (ordered[0] as FindingRow).severity
  return {
    key,
    title: table ?? 'Functions',
    phrase: worst === 'info' ? 'public on purpose' : phraseFor(ordered, persona),
    worst,
    problems: worst === 'info' ? 0 : ordered.length,
    findings: ordered,
  }
}

/** One card per table, worst first. Low findings go to a separate list of hints. */
export function groupFindings(findings: readonly FindingRow[], persona: Persona): { cards: FindingCard[]; hints: FindingRow[] } {
  const hints = findings.filter((f) => f.severity === 'low').sort(bySeverityThenRule)
  const groups = new Map<string, FindingRow[]>()
  for (const finding of findings.filter((f) => f.severity !== 'low')) {
    const key = `${finding.severity === 'info' ? 'info' : 'counted'}:${finding.table_name ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), finding])
  }
  const isFunctions = (card: FindingCard): number => Number(card.title === 'Functions')
  const cards = [...groups.entries()]
    .map(([key, group]) => toCard(key, group[0]?.table_name ?? null, group, persona))
    // Within a severity, the card with the most problems reads first, and functions last.
    .sort(
      (a, b) =>
        rank(a.worst) - rank(b.worst) || b.problems - a.problems || isFunctions(a) - isFunctions(b) || a.title.localeCompare(b.title),
    )
  return { cards, hints }
}
