#!/usr/bin/env node
import { scan } from '@redrow/engine'
import { run } from './cli'
import { openConnection } from './connection'
import { isColorSupported } from './render'

/** Secrets come from the environment or `.env`. Values already set win over the file. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile()
  } catch (error: unknown) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    if (!missing) throw error
  }
}

loadDotEnv()

process.exitCode = await run(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    colorSupported: isColorSupported,
    spinner: process.stderr.isTTY === true,
  },
  { connect: openConnection, scan },
)
