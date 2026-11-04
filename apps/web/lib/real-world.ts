import data from '../data/real-world.json'

export type Assessment = 'likely leak' | 'intended sharing' | 'needs review'

export interface RealWorldAccess {
  readonly actor: string
  readonly table: string
  readonly action: string
  readonly rows: number
}

/** Score and access come from Red Row's reports. `assessment` and `reason` are our judgment of intent. */
export interface RealWorldApp {
  readonly file: string
  readonly name: string
  readonly purpose: string
  readonly score: number
  readonly grade: string
  readonly critical: number
  readonly tables: number
  readonly probes: number
  readonly access: readonly RealWorldAccess[]
  readonly summary: string
  readonly assessment: Assessment
  readonly reason: string
  readonly aiTool: string
  readonly prompt: string
}

export const REAL_WORLD_APPS = data.apps as readonly RealWorldApp[]
