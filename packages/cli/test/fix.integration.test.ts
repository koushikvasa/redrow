import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { introspect, scan, toReport, type Report } from '@redrow/engine'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { run, type CliDeps } from '../src/cli'
import { openConnection, parseConnection } from '../src/connection'
import { generateWithClaude } from '../src/fix/ai'
import { buildFixPrompt } from '../src/fix/prompt'
import { applyStatements, validateStatements } from '../src/fix/run'
import { captureIO } from './helpers'

const URL_FROM_ENV = process.env.REDROW_TEST_DB_URL || undefined
const SCHEMA = 'redrow_fix_it'
const OWNER_A = '00000000-0000-4000-8000-00000000000a'
const OWNER_B = '00000000-0000-4000-8000-00000000000b'
const SECRET_A = 'seeded-secret-alpha'
const SECRET_B = 'seeded-secret-bravo'

const SETUP = `
  drop schema if exists ${SCHEMA} cascade;
  create schema ${SCHEMA};
  grant usage on schema ${SCHEMA} to anon, authenticated;

  create table ${SCHEMA}.open_notes (id serial primary key, user_id uuid not null, body text);
  grant all on ${SCHEMA}.open_notes to anon, authenticated;
  grant usage on sequence ${SCHEMA}.open_notes_id_seq to anon, authenticated;
  insert into ${SCHEMA}.open_notes (user_id, body) values
    ('${OWNER_A}', '${SECRET_A}'), ('${OWNER_B}', '${SECRET_B}');

  create table ${SCHEMA}.shared_notes (id serial primary key, user_id uuid not null, body text);
  grant all on ${SCHEMA}.shared_notes to anon, authenticated;
  grant usage on sequence ${SCHEMA}.shared_notes_id_seq to anon, authenticated;
  insert into ${SCHEMA}.shared_notes (user_id, body) values
    ('${OWNER_A}', '${SECRET_A}'), ('${OWNER_B}', '${SECRET_B}');
  alter table ${SCHEMA}.shared_notes enable row level security;
  create policy everyone_reads on ${SCHEMA}.shared_notes for select to authenticated using (true);

  create view ${SCHEMA}.notes_view as select id, user_id from ${SCHEMA}.shared_notes;
  grant select on ${SCHEMA}.notes_view to anon, authenticated;

  create function ${SCHEMA}.find_notes(q text) returns bigint
    language sql security definer as $$ select count(*) from ${SCHEMA}.shared_notes where body = q $$;
`

describe.skipIf(URL_FROM_ENV === undefined)('redrow fix, against a real database', () => {
  const url = URL_FROM_ENV as string
  const admin = URL_FROM_ENV === undefined ? undefined : openConnection(parseConnection(url))
  const sql = admin?.sql as NonNullable<typeof admin>['sql']
  const cwd = mkdtempSync(join(tmpdir(), 'redrow-fix-it-'))

  const rlsIsOn = async (table: string): Promise<boolean> => {
    const rows = await sql<{ on: boolean }[]>`
      select c.relrowsecurity as on from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${SCHEMA} and c.relname = ${table}`
    return rows[0]?.on === true
  }

  const scanReport = async (): Promise<Report> =>
    toReport(await scan(sql, { schemas: [SCHEMA], ownerColumns: {}, publicTables: [] }))

  beforeAll(async () => {
    writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ schemas: [SCHEMA] }))
    await sql.unsafe(SETUP)
  })

  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`)
    await admin?.end()
  })

  it('builds a prompt with none of the values from seeded rows', async () => {
    const report = await scanReport()
    const catalog = await introspect(sql, [SCHEMA], {})
    const prompt = buildFixPrompt(report, catalog)
    const text = prompt.system + prompt.user
    expect(text).toContain('open_notes')
    for (const value of [SECRET_A, SECRET_B, OWNER_A, OWNER_B]) expect(text).not.toContain(value)
  }, 30000)

  it('validates a migration without changing anything', async () => {
    await validateStatements(sql, [`alter table ${SCHEMA}.open_notes enable row level security`])
    expect(await rlsIsOn('open_notes')).toBe(false)
  }, 30000)

  it('reports a statement the database rejects', async () => {
    await expect(
      validateStatements(sql, [`alter table ${SCHEMA}.no_such_table enable row level security`]),
    ).rejects.toThrow(/does not exist/)
  }, 30000)

  // The reason for the extended protocol: if the parser were ever fooled, a COMMIT inside
  // the "rolled back" validation would make everything before it permanent.
  it('has the server refuse a second statement, so a commit cannot sneak through', async () => {
    const smuggled = `alter table ${SCHEMA}.open_notes enable row level security; commit`
    await expect(validateStatements(sql, [smuggled])).rejects.toThrow(/multiple commands/)
    expect(await rlsIsOn('open_notes')).toBe(false)
    await expect(applyStatements(sql, [smuggled])).rejects.toThrow(/multiple commands/)
    expect(await rlsIsOn('open_notes')).toBe(false)
  }, 30000)

  it('applies nothing when one statement of a migration fails', async () => {
    await expect(
      applyStatements(sql, [
        `alter table ${SCHEMA}.open_notes enable row level security`,
        `alter table ${SCHEMA}.no_such_table enable row level security`,
      ]),
    ).rejects.toThrow(/does not exist/)
    expect(await rlsIsOn('open_notes')).toBe(false)
  }, 30000)

  it('fixes it all with templates: scan, fix --apply, 100/A, and no row was touched', async () => {
    const report = await scanReport()
    expect(report.summary.score).toBeLessThan(100)
    writeFileSync(join(cwd, 'report.json'), JSON.stringify(report))
    const deps: CliDeps = {
      connect: openConnection,
      scan,
      fix: { introspect, validate: validateStatements, apply: applyStatements, generate: generateWithClaude },
    }
    const io = captureIO({ cwd, env: { ANTHROPIC_API_KEY: '' } })

    const code = await run(['fix', '--from', 'report.json', '--db', url, '--apply', '--out', 'fix.sql', '-y'], io, deps)

    expect(io.err()).toMatch(/rule-based/)
    const remaining = (await scanReport()).findings.map((f) => `${f.id} ${f.table}: ${f.description}`)
    expect(remaining).toEqual([])
    expect(io.out()).toMatch(/→ 100\/100 \(A\)/)
    expect(code).toBe(0)
    expect(readFileSync(join(cwd, 'fix.sql'), 'utf8')).toMatch(/^begin;$/m)
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(SCHEMA)}.open_notes`
    expect(rows[0]?.n).toBe(2)
    const output = io.out() + io.err()
    expect(output).not.toContain(SECRET_A)
    expect(output).not.toContain(new URL(url).password)
  }, 60000)
})
