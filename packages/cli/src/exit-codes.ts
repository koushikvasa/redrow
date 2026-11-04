import { meetsSeverity, type Finding, type Severity } from '@redrow/engine'

export const EXIT_OK = 0
export const EXIT_FINDINGS = 1
export const EXIT_ERROR = 2

/** 1 when any finding is at or above `threshold`, else 0. Failures to run exit 2, elsewhere. */
export const exitCodeFor = (findings: readonly Finding[], threshold: Severity): number =>
  findings.some((finding) => meetsSeverity(finding.severity, threshold)) ? EXIT_FINDINGS : EXIT_OK
