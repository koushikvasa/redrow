import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { toReport, type Report, type ScanOptions, type ScanResult, type Severity } from '@redrow/engine'
import type { CliDeps, CliIO } from '../cli'
import { DEFAULT_CONFIG_FILE, loadConfig, type RedrowConfig } from '../config'
import {
  PRODUCTION_OVERRIDE_FLAG,
  assertAllowedTarget,
  describeDbError,
  isAllowedHost,
  needsProductionOverride,
  parseConnection,
  type ConnectionTarget,
} from '../connection'
import { CliError } from '../errors'
import { EXIT_ERROR, EXIT_OK, exitCodeFor } from '../exit-codes'
import { createProgress } from '../progress'
import { renderReport } from '../render'
import { renderHtmlReport } from '../report/html'
import { sanitizeForTerminal, toTerminalSafeJson } from '../sanitize'

export const SAFETY_BANNER = 'All write probes run inside transactions that are rolled back.'
const SIDE_EFFECTS_NOTE =
  "A rollback can't undo sequence values, or outside effects from triggers and extensions such as dblink or http."

export interface ScanFlags {
  readonly db?: string
  readonly config?: string
  readonly only?: string
  readonly severity: Exclude<Severity, 'info'>
  readonly json?: boolean
  readonly html?: string
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

export function toScanOptions(flags: ScanFlags, config: RedrowConfig): ScanOptions {
  const { userA, userB } = config.tenants
  return {
    schemas: config.schemas,
    tables: parseOnly(flags.only) ?? config.tables,
    readOnly: flags.readOnly ?? false,
    ownerColumns: config.ownerColumns,
    publicTables: config.publicTables,
    roles: { anon: config.roles.anon, authenticated: config.roles.authenticated },
    ...(userA === null || userB === null ? {} : { actors: { userA, userB } }),
  }
}

export function resolveTarget(flags: { readonly db?: string }, io: CliIO): ConnectionTarget {
  const url = flags.db ?? io.env.REDROW_DB_URL
  if (url === undefined || url === '') {
    throw new CliError('No database to scan. Pass --db <url> or set REDROW_DB_URL.')
  }
  return parseConnection(url)
}

/** A config file can hide findings, so that is always said out loud, and which file did it. */
function announceDeclaredTables(flags: ScanFlags, config: RedrowConfig, io: CliIO): void {
  if (config.publicTables.length === 0) return
  const names = config.publicTables.map(sanitizeForTerminal).join(', ')
  const source = sanitizeForTerminal(flags.config ?? DEFAULT_CONFIG_FILE)
  io.stderr(`Declared public by ${source}: ${names}. Anon reads of these score nothing.\n`)
}

/** Every Supabase project in a region shares a pooler host, so a bare entry opens up all of them. */
function warnAboutBareHosts(config: RedrowConfig, io: CliIO): void {
  for (const entry of config.allowHosts.filter((allowed) => !allowed.includes('/'))) {
    io.stderr(
      `Warning: allowHosts lists the bare host ${sanitizeForTerminal(entry)}, which covers every login on it. ` +
        'Use host/login to name one project.\n',
    )
  }
}

/** A config file can open up a host, so that is always said out loud too. */
function announceTarget(target: ConnectionTarget, config: RedrowConfig, io: CliIO): void {
  if (!needsProductionOverride(target)) return
  const name = sanitizeForTerminal(target.label)
  io.stderr(
    isAllowedHost(target, config.allowHosts)
      ? `Scanning ${name}: it is listed in allowHosts in your config.\n`
      : `Warning: scanning ${name} because you passed ${PRODUCTION_OVERRIDE_FLAG}.\n`,
  )
}

function writeHtml(report: Report, path: string, io: CliIO): void {
  try {
    writeFileSync(resolve(io.cwd, path), renderHtmlReport(report))
  } catch {
    throw new CliError(`Could not write the HTML report to ${sanitizeForTerminal(path)}`)
  }
  io.stderr(`HTML report written to ${sanitizeForTerminal(path)}\n`)
}

function writeReport(result: ScanResult, flags: ScanFlags, io: CliIO): void {
  const report = toReport(result)
  if (flags.html !== undefined) writeHtml(report, flags.html, io)
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
  assertAllowedTarget(target, flags.iKnowWhatImDoing ?? false, config.allowHosts)
  // Status goes to stderr, so stdout stays valid JSON under --json.
  io.stderr(`${SAFETY_BANNER}\n${SIDE_EFFECTS_NOTE}\n`)
  warnAboutBareHosts(config, io)
  announceTarget(target, config, io)
  announceDeclaredTables(flags, config, io)
  const result = await runProbes(flags, config, target, io, deps)
  writeReport(result, flags, io)
  const code = exitCodeFor(result.findings, flags.severity)
  if (code === EXIT_OK && provedNothing(result)) {
    io.stderr('redrow: every probe was inconclusive, so this scan proves nothing.\n')
    return EXIT_ERROR
  }
  return code
}
