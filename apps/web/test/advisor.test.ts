import { describe, expect, it } from 'vitest'
import { advisorComparisonFor, advisorText, isAdvisorMiss, redRowText, type ComparisonRow } from '../lib/advisor'

const CARENOTE = 'CareNote demo'

const rowsOf = (): readonly ComparisonRow[] => advisorComparisonFor(CARENOTE, 0)?.rows ?? []
const row = (id: string): ComparisonRow => {
  const found = rowsOf().find((r) => r.id === id)
  if (found === undefined) throw new Error(`no row ${id}`)
  return found
}

describe('advisorComparisonFor', () => {
  it('labels the date the Advisor was run', () => {
    expect(advisorComparisonFor(CARENOTE, 0)?.advisorRunOn).toBe('Nov 4, 2026')
  })

  it('shows only on a leaking CareNote, so it never contradicts a fixed scan', () => {
    expect(advisorComparisonFor(CARENOTE, 100)).toBeNull()
    expect(advisorComparisonFor('Red Row HQ (self-scan)', 0)).toBeNull()
  })
})

describe('the comparison rows', () => {
  it('shows the two headline leaks as not flagged against their proven counts', () => {
    expect(advisorText(row('patients-select'))).toBe('not flagged')
    expect(redRowText(row('patients-select'))).toBe('🔓 80 rows')
    expect(advisorText(row('notes-delete'))).toBe('not flagged')
    expect(redRowText(row('notes-delete'))).toBe('🔓 240 rows')
    expect(rowsOf().slice(0, 2).map((r) => r.id)).toEqual(['patients-select', 'notes-delete'])
  })

  it('does not claim the blocked update attack as proven', () => {
    expect(advisorText(row('notes-update'))).toBe('not flagged')
    expect(redRowText(row('notes-update'))).toBe('Warned, attack blocked')
    expect(isAdvisorMiss(row('notes-update'))).toBe(false)
  })

  it('says so where Red Row found a problem only in the schema, or did not check', () => {
    expect(redRowText(row('summary-view'))).toBe('Found in schema')
    expect(redRowText(row('search-function'))).toBe('Found in schema')
    expect(redRowText(row('leaked-passwords'))).toBe('Not checked')
  })

  it('shows a proven attack that has no row count as allowed', () => {
    expect(redRowText(row('appointments-insert'))).toBe('🔓 allowed')
  })

  it('lists all eight items the Advisor comparison covers', () => {
    expect(rowsOf()).toHaveLength(8)
    expect(rowsOf().filter((r) => r.advisor === 'flagged')).toHaveLength(5)
    expect(rowsOf().filter(isAdvisorMiss).map((r) => r.id)).toEqual(['patients-select', 'notes-delete'])
  })
})
