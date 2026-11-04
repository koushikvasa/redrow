import data from '../data/fixed-reference.json'
import type { ProbeRow } from './types'

/** A real scan of CareNote with the reference fix applied. See demo-target/scripts/capture-fixed-reference.mjs. */
export interface FixedReference {
  readonly project: string
  readonly scannedAt: string
  readonly score: number
  readonly grade: string
  readonly tablesScanned: number
  readonly probesRun: number
  readonly probes: readonly ProbeRow[]
}

const REFERENCE = data as FixedReference

/** Nothing to compare once the live database is fixed too, as it is right after a stage demo. */
export const fixedReferenceFor = (project: string, liveScore: number): FixedReference | null =>
  project === REFERENCE.project && liveScore < 90 ? REFERENCE : null
