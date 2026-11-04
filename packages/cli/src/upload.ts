import type { Report } from '@redrow/engine'
import type { CliIO } from './cli'
import { CliError } from './errors'
import { sanitizeForTerminal } from './sanitize'

const UPLOAD_TIMEOUT_MS = 30_000

interface UploadTarget {
  readonly url: string
  readonly key: string
  readonly project: string
}

/** Checked before the scan starts, so a missing setting doesn't waste one. */
export function resolveUpload(project: string | undefined, io: CliIO): UploadTarget {
  if (project === undefined || project === '') throw new CliError('--upload needs --project <name>.')
  const url = io.env.REDROW_INGEST_URL
  if (!url) throw new CliError('--upload needs REDROW_INGEST_URL. Add it to .env.')
  const key = io.env.REDROW_INGEST_KEY
  if (!key) throw new CliError('--upload needs REDROW_INGEST_KEY. Add it to .env.')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new CliError('REDROW_INGEST_URL is not a valid URL.')
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new CliError('REDROW_INGEST_URL must use https, because the key travels with the request.')
  }
  return { url, key, project }
}

/** The report holds counts and catalog text only, and no connection details. */
export async function uploadReport(report: Report, target: UploadTarget, io: CliIO): Promise<void> {
  let response: Response
  try {
    response = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-redrow-key': target.key },
      body: JSON.stringify({ project: target.project, report }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    })
  } catch {
    throw new CliError('The scan finished, but the upload could not reach HQ.')
  }
  if (!response.ok) throw new CliError(`The scan finished, but the upload failed: HTTP ${response.status}.`)
  io.stderr(`Uploaded to HQ as ${sanitizeForTerminal(target.project)}.\n`)
}
