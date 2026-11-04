import { ENGINE_VERSION, type ScanOptions, type ScanResult } from '@redrow/engine'
import { Command, CommanderError, Option } from 'commander'
import type { Sql } from 'postgres'
import { runFix, type FixDeps, type FixFlags } from './commands/fix'
import { runInit } from './commands/init'
import { runScan, type ScanFlags } from './commands/scan'
import type { Connection, ConnectionTarget } from './connection'
import { CliError } from './errors'
import { EXIT_ERROR, EXIT_OK } from './exit-codes'
import { sanitizeForTerminal } from './sanitize'

export interface CliIO {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly colorSupported: boolean
  /** Show a spinner on stderr. Only true on a real terminal. */
  readonly spinner: boolean
  /** Asks a yes/no question. Missing when there is no terminal to ask on. */
  readonly confirm?: (question: string) => Promise<boolean>
}

export interface CliDeps {
  readonly connect: (target: ConnectionTarget) => Connection
  readonly scan: (sql: Sql, options: ScanOptions) => Promise<ScanResult>
  readonly fix?: FixDeps
}

function buildProgram(io: CliIO, deps: CliDeps, setExitCode: (code: number) => void): Command {
  const program = new Command('redrow')
    .description('AI wrote your RLS. Red Row proves whether it leaks.')
    .version(ENGINE_VERSION)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })

  program
    .command('init')
    .description('Write a starter redrow.config.json')
    .option('--force', 'overwrite an existing config')
    .action((flags: { force?: boolean }) => {
      setExitCode(runInit(flags.force ?? false, io))
    })

  program
    .command('scan')
    .description('Attack a database with simulated users and report what leaks. Every probe is rolled back.')
    .option('--db <url>', 'connection string (falls back to REDROW_DB_URL)')
    .option('--config <path>', 'config file (default: redrow.config.json, if present)')
    .option('--only <tables>', 'comma-separated tables to scan')
    .addOption(
      new Option('--severity <level>', 'exit 1 on findings at or above this level')
        .choices(['low', 'medium', 'high', 'critical'])
        .default('low'),
    )
    .option('--json', 'print the report as JSON')
    .option('--html <file>', 'also write a self-contained HTML report')
    .option('--upload', 'send the report to HQ (needs REDROW_INGEST_URL and REDROW_INGEST_KEY)')
    .option('--project <name>', 'the HQ project to upload to')
    .option('--verbose', 'list every probe')
    .option('--no-color', 'disable color')
    .option('--read-only', 'skip all write probes')
    .option('-y, --i-know-what-im-doing', "scan a remote database whose name doesn't contain test, demo or staging")
    .action(async (flags: ScanFlags) => {
      setExitCode(await runScan(flags, io, deps))
    })

  program
    .command('fix')
    .description('Write a migration that fixes a report\'s findings, using Claude if ANTHROPIC_API_KEY is set')
    .requiredOption('--from <file>', 'the report, from redrow scan --json')
    .option('--db <url>', 'connection string (falls back to REDROW_DB_URL)')
    .option('--config <path>', 'config file (default: redrow.config.json, if present)')
    .option('--apply', 'apply the migration and rescan, after asking')
    .option('--out <file>', 'where to write it (default: redrow-fix-<timestamp>.sql)')
    .option('-y, --i-know-what-im-doing', "skip the --apply question, and allow a remote database whose name doesn't contain test, demo or staging")
    .action(async (flags: FixFlags) => {
      setExitCode(await runFix(flags, io, deps))
    })

  return program
}

/** Runs the CLI and returns the exit code: 0 clean, 1 findings, 2 could not run. */
export async function run(argv: readonly string[], io: CliIO, deps: CliDeps): Promise<number> {
  let exitCode = EXIT_OK
  const program = buildProgram(io, deps, (code) => {
    exitCode = code
  })
  try {
    await program.parseAsync([...argv], { from: 'user' })
    return exitCode
  } catch (error: unknown) {
    // Commander has already printed its own message.
    if (error instanceof CommanderError) return error.exitCode === 0 ? EXIT_OK : EXIT_ERROR
    const message = error instanceof CliError ? error.message : `Unexpected error: ${String(error)}`
    io.stderr(`redrow: ${message.split('\n').map(sanitizeForTerminal).join('\n')}\n`)
    return EXIT_ERROR
  }
}
