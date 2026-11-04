import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan, type Report } from '@redrow/engine'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run } from '../src/cli'
import { openConnection, parseConnection } from '../src/connection'
import { captureIO } from './helpers'

const URL_FROM_ENV = process.env.REDROW_TEST_DB_URL || undefined
const SCHEMA = 'redrow_cli_it'

describe.skipIf(URL_FROM_ENV === undefined)('redrow scan, against a real database', () => {
  const url = URL_FROM_ENV as string
  const realDeps = { connect: openConnection, scan }
  const admin = URL_FROM_ENV === undefined ? undefined : openConnection(parseConnection(url))
  const cwd = mkdtempSync(join(tmpdir(), 'redrow-cli-it-'))

  beforeAll(async () => {
    writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ schemas: [SCHEMA] }))
    await admin?.sql.unsafe(`
      drop schema if exists ${SCHEMA} cascade;
      create schema ${SCHEMA};
      grant usage on schema ${SCHEMA} to anon, authenticated;
      create table ${SCHEMA}.open_table (id serial primary key, user_id uuid, email text);
      grant all on ${SCHEMA}.open_table to anon, authenticated;
      insert into ${SCHEMA}.open_table (user_id, email) values
        ('00000000-0000-4000-8000-00000000000a', 'a@example.test'),
        ('00000000-0000-4000-8000-00000000000b', 'b@example.test');
    `)
  })

  afterAll(async () => {
    await admin?.sql.unsafe(`drop schema if exists ${SCHEMA} cascade`)
    await admin?.end()
  })

  it('emits valid JSON in the agreed shape, finds the leak and exits 1', async () => {
    const io = captureIO({ cwd })
    const code = await run(['scan', '--db', url, '--json', '--i-know-what-im-doing'], io, realDeps)
    expect(code).toBe(1)
    const report = JSON.parse(io.out()) as Report
    expect(Object.keys(report).sort()).toEqual(['database', 'findings', 'scannedAt', 'summary', 'version'])
    expect(report.findings.map((f) => f.id)).toContain('RR001')
    expect(report.findings.map((f) => f.id)).toContain('RR101')
  }, 30000)

  it('never prints row contents or the connection string', async () => {
    const io = captureIO({ cwd })
    await run(['scan', '--db', url, '--json', '--i-know-what-im-doing'], io, realDeps)
    const output = io.out() + io.err()
    expect(output).not.toContain('a@example.test')
    expect(output).not.toContain(new URL(url).password)
  }, 30000)

  it('leaves the data as it found it', async () => {
    const io = captureIO({ cwd })
    await run(['scan', '--db', url, '--json', '--i-know-what-im-doing'], io, realDeps)
    const fresh = postgres(url, { max: 1, onnotice: () => {}, ssl: parseConnection(url).ssl })
    try {
      const rows = await fresh<{ n: number }[]>`select count(*)::int as n from ${fresh(SCHEMA)}.open_table`
      expect(rows[0]?.n).toBe(2)
    } finally {
      await fresh.end()
    }
  }, 30000)

  it('exits 2 with a clear error when the host is unreachable', async () => {
    const io = captureIO({ cwd })
    const code = await run(
      ['scan', '--db', 'postgres://u:hunter2@127.0.0.1:1/x_test'],
      io,
      realDeps,
    )
    expect(code).toBe(2)
    expect(io.err()).toContain('Session pooler')
    expect(io.err()).not.toContain('hunter2')
  }, 30000)
})
