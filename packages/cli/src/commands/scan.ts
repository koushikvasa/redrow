import { toReport, type ScanOptions, type ScanResult, type Severity } from '@redrow/engine'
import type { CliDeps, CliIO } from '../cli'
import { loadConfig, type RedrowConfig } from '../config'
import {
  PRODUCTION_OVERRIDE_FLAG,
  assertAllowedTarget,
  describeDbError,
  needsProductionOverride,
  parseConnection,
  type ConnectionTarget,
} from '../connection'
import { CliError } from '../errors'
import { EXIT_ERROR, EXIT_OK, exitCodeFor } from '../exit-codes'
import { createProgress } from '../progress'
import { renderReport } from '../render'
import { sanitizeForTerminal, toTerminalSafeJson } from '../sanitize'

export const SAFETY_BANNER = 'All write probes run inside transactions that are rolled back.'
const SIDE_EFFECTS_NOTE =
  "A rollback can't undo sequence values, or outside effects from triggers and extensions such as dblink or http."

export interface ScanFlags {
  readonly db?: string
  readonly config?: string
  readonly only?: string
  readonly severity: Severity
  readonly json?: boolean
  readonly verbose?: boolean
  readonly color: boolean
  readonly readOnly?: boolean
  readonly iKnowWhatImDoing?: boolean
}

const parseOnly = (only: string | undefined): readonly string[] | undefined =>
  only
    ?.split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')

function toScanOptions(flags: ScanFlags, config: RedrowConfig): ScanOptions {
  const { userA, userB } = config.tenants
  return {
    schemas: config.schemas,
    tables: parseOnly(flags.only) ?? config.tables,
    readOnly: flags.readOnly ?? false,
    ownerColumns: config.ownerColumns,
    roles: { anon: config.roles.anon, authenticated: config.roles.authenticated },
    ...(userA === null || userB === null ? {} : { actors: { userA, userB } }),
  }
}

function resolveTarget(flags: ScanFlags, io: CliIO): ConnectionTarget {
  const url = flags.db ?? io.env.REDROW_DB_URL
  if (url === undefined || url === '') {
    throw new CliError('No database to scan. Pass --db <url> or set REDROW_DB_URL.')
  }
  const target = parseConnection(url)
  assertAllowedTarget(target, flags.iKnowWhatImDoing ?? false)
  return target
}

function writeReport(result: ScanResult, flags: ScanFlags, io: CliIO): void {
  const report = toReport(result)
  if (flags.json === true) {
    io.stdout(`${toTerminalSafeJson(report)}\n`)
    return
  }
  io.stdout(renderReport(report, { color: flags.color && io.colorSupported, verbose: flags.verbose ?? false }))
}

async function runProbes(
  flags: ScanFlags,
  config: RedrowConfig,
  target: ConnectionTarget,
  io: CliIO,
  deps: CliDeps,
): Promise<ScanResult> {
  const connection = deps.connect(target)
  const progress = createProgress(io.spinner && flags.json !== true)
  try {
    return await deps.scan(connection.sql, { ...toScanOptions(flags, config), onPhase: progress.onPhase })
  } catch (error: unknown) {
    throw new CliError(describeDbError(error, target))
  } finally {
    progress.stop()
    await connection.end()
  }
}

/** A scan where nothing could be tested proved nothing, so it can't pass as clean. */
const provedNothing = (result: ScanResult): boolean =>
  result.probes.length > 0 && result.probes.every((p) => p.outcome === 'inconclusive')

export async function runScan(flags: ScanFlags, io: CliIO, deps: CliDeps): Promise<number> {
  const target = resolveTarget(flags, io)
  const config = loadConfig(flags.config, io.cwd)
  // Status goes to stderr, so stdout stays valid JSON under --json.
  io.stderr(`${SAFETY_BANNER}\n${SIDE_EFFECTS_NOTE}\n`)
  if (needsProductionOverride(target)) {
    io.stderr(`Warning: scanning ${sanitizeForTerminal(target.label)} because you passed ${PRODUCTION_OVERRIDE_FLAG}.\n`)
  }
  const result = await runProbes(flags, config, target, io, deps)
  writeReport(result, flags, io)
  const code = exitCodeFor(result.findings, flags.severity)
  if (code === EXIT_OK && provedNothing(result)) {
    io.stderr('redrow: every probe was inconclusive, so this scan proves nothing.\n')
    return EXIT_ERROR
  }
  return code
}
