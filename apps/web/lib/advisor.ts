import data from '../data/advisor-comparison.json'

export type AdvisorVerdict = 'flagged' | 'not_flagged'
/** `proven`: an attack got through. `warned`: a schema warning, but the attack was blocked. `found`: schema only, no attack run. */
export type RedRowVerdict = 'proven' | 'warned' | 'found' | 'not_checked'

export interface ComparisonRow {
  readonly id: string
  readonly leak: string
  readonly policy: string
  readonly advisor: AdvisorVerdict
  readonly redRow: RedRowVerdict
  readonly rows: number | null
}

export interface AdvisorComparison {
  readonly project: string
  readonly advisorRunOn: string
  readonly rows: readonly ComparisonRow[]
}

const COMPARISON = data as AdvisorComparison
const LEAKING_BELOW = 90

/** The counts are from a leaking scan, so they'd contradict the page once the live database is fixed. */
export const advisorComparisonFor = (project: string, liveScore: number): AdvisorComparison | null =>
  project === COMPARISON.project && liveScore < LEAKING_BELOW ? COMPARISON : null

export const advisorText = (row: ComparisonRow): string => (row.advisor === 'flagged' ? 'flagged' : 'not flagged')

export function redRowText(row: ComparisonRow): string {
  if (row.redRow === 'warned') return 'Warned, attack blocked'
  if (row.redRow === 'found') return 'Found in schema'
  if (row.redRow === 'not_checked') return 'Not checked'
  return row.rows === null ? '🔓 allowed' : `🔓 ${row.rows} rows`
}

export const isAdvisorMiss = (row: ComparisonRow): boolean => row.advisor === 'not_flagged' && row.redRow === 'proven'
