import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Report } from '@redrow/engine'
import { z } from 'zod'
import { CliError } from '../errors'

// The file could have been edited or come from anywhere, so it is checked like any input.
// Only what `fix` relies on is strict: H5 and H6 fields can be added without breaking it.
const reportSchema = z.looseObject({
  version: z.literal(1, { error: 'unsupported report version. Rescan with this version of redrow.' }),
  database: z.looseObject({ host: z.string(), name: z.string(), schemas: z.array(z.string()).min(1) }),
  findings: z.array(
    z.looseObject({
      id: z.string().regex(/^RR\d{3}$/),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      table: z.string().nullable(),
      policy: z.string().nullable(),
      description: z.string(),
      remediation: z.string(),
      evidence: z.looseObject({ kind: z.enum(['probe', 'catalog']), schema: z.string() }),
    }),
  ),
  summary: z.looseObject({ score: z.number().min(0).max(100), grade: z.enum(['A', 'B', 'C', 'D', 'F']) }),
})

/** Windows PowerShell 5.1 writes UTF-16 for `redrow scan --json > report.json`. */
function decode(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8')
  return bytes.toString('utf8')
}

function readJson(path: string, label: string): unknown {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    throw new CliError(`Could not read report file ${label}`)
  }
  try {
    return JSON.parse(decode(bytes))
  } catch {
    // Not the parser's message: it quotes the input, and this could be pointed at a .env file.
    throw new CliError(`${label} is not valid JSON. Expected the output of redrow scan --json.`)
  }
}

export function loadReport(path: string, cwd: string): Report {
  const result = reportSchema.safeParse(readJson(resolve(cwd, path), path))
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.') || '(top level)'}: ${issue.message}`)
    throw new CliError(`Invalid report in ${path}:\n${problems.join('\n')}`)
  }
  return result.data as unknown as Report
}
