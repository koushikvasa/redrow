import type { ScanPhase } from '@redrow/engine'
import ora from 'ora'

const PHASE_TEXT: Readonly<Record<ScanPhase, string>> = {
  introspect: 'Reading tables and policies',
  actors: 'Picking test users',
  probes: 'Attacking RLS (every probe is rolled back)',
}

export interface Progress {
  readonly onPhase: (phase: ScanPhase) => void
  readonly stop: () => void
}

/** A spinner on stderr, so it can never end up in `--json` output. */
export function createProgress(enabled: boolean): Progress {
  if (!enabled) return { onPhase: () => {}, stop: () => {} }
  const spinner = ora({ stream: process.stderr })
  return {
    onPhase: (phase) => {
      spinner.start(PHASE_TEXT[phase])
    },
    stop: () => {
      spinner.stop()
    },
  }
}
