#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { introspect, scan } from '@redrow/engine'
import { run } from './cli'
import { openConnection } from './connection'
import { generateWithClaude } from './fix/ai'
import { applyStatements, validateStatements } from './fix/run'
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

/** The question goes to stderr, like every other status line. Anything but yes means no. */
async function confirmOnTerminal(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim())
  } finally {
    prompt.close()
  }
}

process.exitCode = await run(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    colorSupported: isColorSupported,
    spinner: process.stderr.isTTY === true,
    ...(process.stdin.isTTY === true ? { confirm: confirmOnTerminal } : {}),
  },
  {
    connect: openConnection,
    scan,
    fix: { introspect, validate: validateStatements, apply: applyStatements, generate: generateWithClaude },
  },
)
