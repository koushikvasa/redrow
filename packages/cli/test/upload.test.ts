import { afterEach, describe, expect, it, vi } from 'vitest'
import { run } from '../src/cli'
import { captureIO, fakeDeps, scanResult } from './helpers'

const DB = 'postgres://u:s3cret@localhost:5432/app_test'
const KEY = 'test-only-ingest-key'
const ARGS = ['scan', '--db', DB, '--upload', '--project', 'CareNote demo']
const ENV = { REDROW_INGEST_URL: 'https://hq.example.test/functions/v1/ingest', REDROW_INGEST_KEY: KEY }

const stubFetch = (status: number): ReturnType<typeof vi.fn> => {
  const stub = vi.fn(async () => new Response('{}', { status }))
  vi.stubGlobal('fetch', stub)
  return stub
}

describe('redrow scan --upload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the project and report with the key, and never the connection string', async () => {
    const stub = stubFetch(201)
    const io = captureIO({ env: ENV })
    expect(await run(ARGS, io, fakeDeps(scanResult({ score: 100, grade: 'A' })))).toBe(0)
    const [url, init] = stub.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(ENV.REDROW_INGEST_URL)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('x-redrow-key')).toBe(KEY)
    const body = JSON.parse(init.body as string) as { project: string; report: { version: number } }
    expect(body.project).toBe('CareNote demo')
    expect(body.report.version).toBe(1)
    expect(init.body).not.toContain('s3cret')
    expect(io.err()).toContain('CareNote demo')
  })

  it('does not upload without --upload', async () => {
    const stub = stubFetch(201)
    await run(['scan', '--db', DB], captureIO({ env: ENV }), fakeDeps(scanResult({ score: 100, grade: 'A' })))
    expect(stub).not.toHaveBeenCalled()
  })

  it.each([
    ['no --project', ['scan', '--db', DB, '--upload'], ENV, /--project/],
    ['no URL', ARGS, { REDROW_INGEST_KEY: KEY }, /REDROW_INGEST_URL/],
    ['no key', ARGS, { REDROW_INGEST_URL: ENV.REDROW_INGEST_URL }, /REDROW_INGEST_KEY/],
    ['a key sent in the clear', ARGS, { ...ENV, REDROW_INGEST_URL: 'http://hq.example.test/ingest' }, /https/],
  ])('refuses before scanning with %s', async (_label, args, env, message) => {
    const stub = stubFetch(201)
    const deps = fakeDeps(scanResult())
    const io = captureIO({ env })
    expect(await run(args, io, deps)).toBe(2)
    expect(io.err()).toMatch(message)
    expect(deps.calls.connect).toEqual([])
    expect(stub).not.toHaveBeenCalled()
  })

  it('exits 2 when the upload fails, without repeating the key', async () => {
    stubFetch(401)
    const io = captureIO({ env: ENV })
    expect(await run(ARGS, io, fakeDeps(scanResult({ score: 100, grade: 'A' })))).toBe(2)
    expect(io.err()).toMatch(/401/)
    expect(io.err()).not.toContain(KEY)
  })

  it('still prints the report when the upload fails', async () => {
    stubFetch(500)
    const io = captureIO({ env: ENV })
    await run(ARGS, io, fakeDeps(scanResult({ score: 100, grade: 'A' })))
    expect(io.out()).toMatch(/100/)
  })

  it('explains a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))))
    const io = captureIO({ env: ENV })
    expect(await run(ARGS, io, fakeDeps(scanResult({ score: 100, grade: 'A' })))).toBe(2)
    expect(io.err()).toMatch(/could not reach/i)
  })
})
