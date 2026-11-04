import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CliIO } from '../cli'
import { DEFAULT_CONFIG_FILE, STARTER_CONFIG } from '../config'
import { CliError } from '../errors'
import { EXIT_OK } from '../exit-codes'

export function runInit(force: boolean, io: CliIO): number {
  const path = resolve(io.cwd, DEFAULT_CONFIG_FILE)
  try {
    // `wx` makes "refuse to overwrite" atomic, rather than checking first and racing.
    writeFileSync(path, STARTER_CONFIG, { flag: force ? 'w' : 'wx' })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new CliError(`${DEFAULT_CONFIG_FILE} already exists. Use --force to overwrite it.`)
    }
    throw new CliError(`Could not write ${DEFAULT_CONFIG_FILE}.`)
  }
  io.stdout(`Created ${DEFAULT_CONFIG_FILE}. Next: redrow scan --db <url>\n`)
  return EXIT_OK
}
