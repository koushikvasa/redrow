import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Introspection, Report } from '@redrow/engine'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli'
import { loadReport } from '../src/fix/report-file'
import { captureIO, fakeDeps, scanResult } from './helpers'

const DB = 'postgres://u:s3cret@localhost:5432/app_test'
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'redrow-fix-'))

const REPORT: Report = {
  version: 1,
  scannedAt: '2026-11-04T12:00:00.000Z',
  database: { host: 'localhost', name: 'app_test', schemas: ['public'] },
  findings: [
    {
      id: 'RR006',
      severity: 'high',
      table: 'v',
      policy: null,
      probe: null,
      description: 'view',
      evidence: { kind: 'catalog', schema: 'public' },
      remediation: 'hint',
    },
  ],
  summary: {
    total: 1,
    bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    score: 40,
    grade: 'D',
    tablesScanned: 1,
    probesRun: 1,
    durationMs: 1,
    probes: [],
    inconclusive: 0,
    warnings: [],
  },
}

const CATALOG: Introspection = {
  tables: [],
  policies: [],
  views: [{ schema: 'public', view: 'v', materialized: false, securityInvoker: false, anonSelect: true, authSelect: true }],
  functions: [],
}

const VALID_AI_SQL = 'begin;\n-- RR006: fix the view\nalter view "public"."v" set (security_invoker = true);\ncommit;\n'

function setup(reportOverride: unknown = REPORT) {
  const cwd = tempDir()
  writeFileSync(join(cwd, 'report.json'), JSON.stringify(reportOverride))
  return cwd
}

function fixDeps(options: {
  ai?: () => Promise<string>
  validate?: (statements: readonly string[]) => Promise<void>
  rescan?: ReturnType<typeof scanResult>
  answeredBy?: string
} = {}) {
  const base = fakeDeps(options.rescan ?? scanResult({ score: 100, grade: 'A' }))
  const calls = { validated: [] as string[][], applied: [] as string[][], aiCalls: 0, prompts: [] as string[], models: [] as string[] }
  return {
    ...base,
    fix: {
      introspect: async () => CATALOG,
      validate: async (_sql: unknown, statements: readonly string[]) => {
        calls.validated.push([...statements])
        await options.validate?.(statements)
      },
      apply: async (_sql: unknown, statements: readonly string[]) => {
        calls.applied.push([...statements])
      },
      generate: async (prompt: { system: string; user: string }, _key: string, model: string) => {
        calls.aiCalls += 1
        calls.prompts.push(prompt.user)
        calls.models.push(model)
        const text = options.ai === undefined ? VALID_AI_SQL : await options.ai()
        return { text, model: options.answeredBy ?? model, usedFallback: options.answeredBy !== undefined }
      },
    },
    log: calls,
  }
}

const sqlFile = (cwd: string): string | undefined => readdirSync(cwd).find((f) => /^redrow-fix-.*\.sql$/.test(f))

describe('redrow fix', () => {
  it('prints help and exits 0 with no database', async () => {
    const io = captureIO()
    expect(await run(['fix', '--help'], io, fixDeps())).toBe(0)
    for (const flag of ['--from', '--db', '--apply', '--out']) expect(io.out()).toContain(flag)
  })

  it('needs --from', async () => {
    expect(await run(['fix', '--db', DB], captureIO(), fixDeps())).toBe(2)
  })

  it('needs a database, because the migration must be validated before it is written', async () => {
    const io = captureIO({ cwd: setup() })
    expect(await run(['fix', '--from', 'report.json'], io, fixDeps())).toBe(2)
    expect(io.err()).toContain('REDROW_DB_URL')
  })

  it('exits 2 on a missing report', async () => {
    const io = captureIO({ cwd: tempDir() })
    expect(await run(['fix', '--from', 'gone.json', '--db', DB], io, fixDeps())).toBe(2)
    expect(io.err()).toContain('gone.json')
  })

  it('has nothing to do for a clean report, and makes no connection', async () => {
    const clean = { ...REPORT, findings: [] }
    const cwd = setup(clean)
    const deps = fixDeps()
    const io = captureIO({ cwd })
    expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(0)
    expect(io.out()).toMatch(/nothing to fix/i)
    expect(deps.calls.connect).toEqual([])
  })

  it('treats a report with only declared exposure as clean', async () => {
    const declared = { ...REPORT, findings: [{ ...REPORT.findings[0], severity: 'info' }] }
    const io = captureIO({ cwd: setup(declared) })
    expect(await run(['fix', '--from', 'report.json', '--db', DB], io, fixDeps())).toBe(0)
    expect(io.out()).toMatch(/nothing to fix/i)
  })

  describe('safety', () => {
    it('applies the production guard before connecting', async () => {
      const deps = fixDeps()
      const io = captureIO({ cwd: setup() })
      const url = 'postgres://u:s3cret@db.example.com/postgres'
      expect(await run(['fix', '--from', 'report.json', '--db', url, '--apply'], io, deps)).toBe(2)
      expect(deps.calls.connect).toEqual([])
      expect(io.err()).not.toContain('s3cret')
    })

    it('refuses a report from a different database, so a fix cannot land in the wrong place', async () => {
      const deps = fixDeps()
      const io = captureIO({ cwd: setup() })
      const other = 'postgres://u:p@localhost:5432/other_test'
      expect(await run(['fix', '--from', 'report.json', '--db', other], io, deps)).toBe(2)
      expect(io.err()).toMatch(/different database/i)
      expect(deps.calls.connect).toEqual([])
    })

    it('rejects a malformed report, which is untrusted input', async () => {
      const io = captureIO({ cwd: setup({ version: 1, findings: 'nope' }) })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, fixDeps())).toBe(2)
      expect(io.err()).toContain('report.json')
    })

    it('rejects a report from a newer format', async () => {
      const io = captureIO({ cwd: setup({ ...REPORT, version: 2 }) })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, fixDeps())).toBe(2)
      expect(io.err()).toMatch(/version/i)
    })

    it('closes the connection on success and on failure', async () => {
      const ok = fixDeps()
      await run(['fix', '--from', 'report.json', '--db', DB], captureIO({ cwd: setup() }), ok)
      expect(ok.calls.ended).toBe(1)
      const bad = fixDeps({ validate: async () => { throw new Error('nope') } })
      await run(['fix', '--from', 'report.json', '--db', DB], captureIO({ cwd: setup() }), bad)
      expect(bad.calls.ended).toBe(1)
    })
  })

  describe('with no API key', () => {
    it('uses the rule-based templates and never calls the model', async () => {
      const cwd = setup()
      const deps = fixDeps()
      const io = captureIO({ cwd })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(0)
      expect(deps.log.aiCalls).toBe(0)
      expect(io.err()).toMatch(/rule-based/i)
      expect(readFileSync(join(cwd, sqlFile(cwd) as string), 'utf8')).toMatch(/^-- RR006/m)
    })

    it('treats an empty key as no key, as a copy of .env.example has', async () => {
      const deps = fixDeps()
      await run(['fix', '--from', 'report.json', '--db', DB], captureIO({ cwd: setup(), env: { ANTHROPIC_API_KEY: '' } }), deps)
      expect(deps.log.aiCalls).toBe(0)
    })
  })

  describe('with an API key', () => {
    const env = { ANTHROPIC_API_KEY: 'key' }

    it('uses the model, naming it, and defaults to claude-sonnet-5-5', async () => {
      const deps = fixDeps()
      const io = captureIO({ cwd: setup(), env })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(0)
      expect(deps.log.models).toEqual(['claude-sonnet-5-5'])
      expect(io.err()).toContain('claude-sonnet-5-5')
    })

    it('honors REDROW_MODEL', async () => {
      const deps = fixDeps()
      await run(['fix', '--from', 'report.json', '--db', DB], captureIO({ cwd: setup(), env: { ...env, REDROW_MODEL: 'claude-opus-5-5' } }), deps)
      expect(deps.log.models).toEqual(['claude-opus-5-5'])
    })

    it('never lets disallowed SQL from the model reach the database', async () => {
      const deps = fixDeps({ ai: async () => 'begin;\n-- RR006\ndrop table public.patients;\ncommit;' })
      const io = captureIO({ cwd: setup(), env })
      await run(['fix', '--from', 'report.json', '--db', DB], io, deps)
      expect(deps.log.validated.flat().join()).not.toContain('drop table')
      expect(deps.log.applied.flat().join()).not.toContain('drop table')
    })

    it('never lets a COMMIT from the model reach the rolled-back validation', async () => {
      const deps = fixDeps({
        ai: async () => 'begin;\n-- RR006\nalter view "public"."v" set (security_invoker = true);\ncommit;\ncommit;',
      })
      await run(['fix', '--from', 'report.json', '--db', DB], captureIO({ cwd: setup(), env }), deps)
      for (const statements of deps.log.validated) {
        expect(statements.some((s) => /^\s*(commit|begin|rollback|end)\b/i.test(s))).toBe(false)
      }
    })

    it('gives the model one chance to correct itself, passing back the reason', async () => {
      let attempts = 0
      const deps = fixDeps({
        ai: async () => {
          attempts += 1
          return attempts === 1 ? 'begin;\n-- RR006\ndrop table x;\ncommit;' : VALID_AI_SQL
        },
      })
      const io = captureIO({ cwd: setup(), env })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(0)
      expect(attempts).toBe(2)
      expect(deps.log.prompts[1]).toMatch(/not allowed/i)
      expect(io.err()).toContain('claude-sonnet-5-5')
    })

    it('falls back to templates, loudly, when the model keeps producing something invalid', async () => {
      const deps = fixDeps({ ai: async () => 'not sql at all' })
      const cwd = setup()
      const io = captureIO({ cwd, env })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(0)
      expect(deps.log.aiCalls).toBe(2)
      expect(io.err()).toMatch(/warning.*rule-based/is)
      expect(sqlFile(cwd)).toBeDefined()
    })

    it('falls back to templates, loudly, when the API call fails, and does not print the key', async () => {
      const deps = fixDeps({ ai: async () => { throw new Error('overloaded key') } })
      const io = captureIO({ cwd: setup(), env })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(0)
      expect(deps.log.aiCalls).toBe(1)
      expect(io.err()).toMatch(/warning.*rule-based/is)
      expect(io.err()).not.toContain('overloaded key')
    })

    it('falls back when the database rejects the model\'s SQL', async () => {
      let validations = 0
      const deps = fixDeps({
        validate: async () => {
          validations += 1
          if (validations <= 2) throw new Error('relation does not exist')
        },
      })
      const io = captureIO({ cwd: setup(), env })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(0)
      expect(deps.log.prompts[1]).toContain('relation does not exist')
      expect(io.err()).toMatch(/rule-based/i)
    })
  })

  describe('when a model reaches past what the report found', () => {
    const OFF_TARGET = 'begin;\n-- RR006: x\nrevoke execute on function auth.uid() from authenticated;\ncommit;\n'

    it('retries with the reason, then uses templates, and never runs it', async () => {
      const cwd = setup()
      const deps = fixDeps({ ai: async () => OFF_TARGET })
      const io = captureIO({ cwd, env: { ANTHROPIC_API_KEY: 'k' } })
      await run(['fix', '--from', 'report.json', '--db', DB], io, deps)
      expect(deps.log.aiCalls).toBe(2)
      expect(deps.log.prompts[1]).toContain('auth.uid')
      expect(deps.log.validated.flat().join()).not.toContain('auth.uid')
      expect(io.err()).toMatch(/warning.*rule-based/is)
    })
  })

  describe('writing the file', () => {
    it('validates before writing, and writes nothing if validation fails', async () => {
      const cwd = setup()
      const deps = fixDeps({ validate: async () => { throw new Error('syntax error') } })
      const io = captureIO({ cwd })
      expect(await run(['fix', '--from', 'report.json', '--db', DB], io, deps)).toBe(2)
      expect(sqlFile(cwd)).toBeUndefined()
      expect(io.err()).toContain('syntax error')
    })

    it('writes to --out, and says where', async () => {
      const cwd = setup()
      const io = captureIO({ cwd })
      await run(['fix', '--from', 'report.json', '--db', DB, '--out', 'chosen.sql'], io, fixDeps())
      expect(readFileSync(join(cwd, 'chosen.sql'), 'utf8')).toContain('begin;')
      expect(io.out()).toContain('chosen.sql')
    })

    it('wraps the file in begin and commit', async () => {
      const cwd = setup()
      await run(['fix', '--from', 'report.json', '--db', DB], captureIO({ cwd }), fixDeps())
      const text = readFileSync(join(cwd, sqlFile(cwd) as string), 'utf8')
      expect(text).toMatch(/^begin;$/m)
      expect(text.trimEnd().endsWith('commit;')).toBe(true)
    })

    it('does not apply without --apply', async () => {
      const deps = fixDeps()
      await run(['fix', '--from', 'report.json', '--db', DB], captureIO({ cwd: setup() }), deps)
      expect(deps.log.applied).toEqual([])
      expect(deps.calls.scanOptions).toEqual([])
    })
  })

  describe('naming the model that answered', () => {
    const env = { ANTHROPIC_API_KEY: 'key' }
    const fileText = (cwd: string): string => readFileSync(join(cwd, sqlFile(cwd) as string), 'utf8')

    it('names it in the migration header and the output', async () => {
      const cwd = setup()
      const io = captureIO({ cwd, env })
      await run(['fix', '--from', 'report.json', '--db', DB], io, fixDeps())
      expect(fileText(cwd).split('\n')[0]).toMatch(/^-- .*claude-sonnet-5-5/)
      expect(fileText(cwd)).toMatch(/^begin;$/m)
      expect(io.err()).toContain('claude-sonnet-5-5')
    })

    it('says so when a fallback model answered instead of the one requested', async () => {
      const cwd = setup()
      const io = captureIO({ cwd, env })
      await run(['fix', '--from', 'report.json', '--db', DB], io, fixDeps({ answeredBy: 'claude-opus-4-8' }))
      const header = fileText(cwd).split('\n')[0] as string
      expect(header).toContain('claude-opus-4-8')
      expect(header).toContain('claude-sonnet-5-5')
      expect(io.err()).toMatch(/claude-sonnet-5-5 declined.*claude-opus-4-8/)
    })

    it('cannot have a line of SQL added through the model name', async () => {
      const cwd = setup()
      const io = captureIO({ cwd, env })
      await run(['fix', '--from', 'report.json', '--db', DB], io, fixDeps({ answeredBy: 'x\ndrop table y;' }))
      expect(fileText(cwd)).not.toMatch(/^drop table/m)
    })
  })

  describe('--apply confirmation', () => {
    const args = ['fix', '--from', 'report.json', '--db', DB, '--apply']

    it('applies when the answer is yes, and names the database in the question', async () => {
      const deps = fixDeps()
      const questions: string[] = []
      const confirm = async (question: string): Promise<boolean> => {
        questions.push(question)
        return true
      }
      expect(await run(args, captureIO({ cwd: setup(), confirm }), deps)).toBe(0)
      expect(deps.log.applied).toHaveLength(1)
      expect(questions[0]).toContain('localhost')
      expect(questions[0]).toMatch(/\[y\/N\]/)
    })

    it('leaves the database alone and keeps the file when the answer is no', async () => {
      const deps = fixDeps()
      const cwd = setup()
      const io = captureIO({ cwd, confirm: async () => false })
      expect(await run(args, io, deps)).toBe(0)
      expect(deps.log.applied).toEqual([])
      expect(deps.calls.scanOptions).toEqual([])
      expect(sqlFile(cwd)).toBeDefined()
      expect(io.out()).toMatch(/not applied/i)
    })

    it('does not ask with -y', async () => {
      const deps = fixDeps()
      const confirm = async (): Promise<boolean> => {
        throw new Error('should not ask')
      }
      expect(await run([...args, '-y'], captureIO({ cwd: setup(), confirm }), deps)).toBe(0)
      expect(deps.log.applied).toHaveLength(1)
    })

    it('refuses before doing anything when there is no terminal to ask on', async () => {
      const deps = fixDeps()
      const io = captureIO({ cwd: setup() })
      expect(await run(args, io, deps)).toBe(2)
      expect(io.err()).toContain('-y')
      expect(deps.calls.connect).toEqual([])
    })

    it('does not ask without --apply', async () => {
      const confirm = async (): Promise<boolean> => {
        throw new Error('should not ask')
      }
      const noApply = ['fix', '--from', 'report.json', '--db', DB]
      expect(await run(noApply, captureIO({ cwd: setup(), confirm }), fixDeps())).toBe(0)
    })
  })

  describe('--apply', () => {
    it('applies, rescans, and prints before and after', async () => {
      const deps = fixDeps()
      const io = captureIO({ cwd: setup() })
      expect(await run(['fix', '--from', 'report.json', '--db', DB, '--apply', '-y'], io, deps)).toBe(0)
      expect(deps.log.applied).toHaveLength(1)
      expect(deps.calls.scanOptions).toHaveLength(1)
      expect(io.out()).toMatch(/40\/100.*D.*→.*100\/100.*A/)
    })

    it('exits 1 when findings remain after applying', async () => {
      const remaining = scanResult({
        score: 96,
        grade: 'A',
        findings: [{ ruleId: 'RR007', severity: 'medium', schema: 'public', title: 't', detail: 'd', fixHint: 'h' }],
        counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 },
      })
      const io = captureIO({ cwd: setup() })
      expect(await run(['fix', '--from', 'report.json', '--db', DB, '--apply', '-y'], io, fixDeps({ rescan: remaining }))).toBe(1)
      expect(io.out()).toContain('96/100')
    })

    it('rescans as the same pinned attacker', async () => {
      const cwd = setup()
      writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ actors: { 'localhost/u': { userA: 'dr.ana@carenote.test' } } }))
      const deps = fixDeps()
      await run(['fix', '--from', 'report.json', '--db', DB, '--apply', '-y'], captureIO({ cwd }), deps)
      expect(deps.calls.scanOptions[0]).toMatchObject({ userAEmail: 'dr.ana@carenote.test' })
    })

    it('rescans the schemas in the report, with the config\'s options', async () => {
      const cwd = setup()
      writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ publicTables: ['p'] }))
      const deps = fixDeps()
      await run(['fix', '--from', 'report.json', '--db', DB, '--apply', '-y'], captureIO({ cwd }), deps)
      expect(deps.calls.scanOptions[0]).toMatchObject({ schemas: ['public'], publicTables: ['p'] })
    })
  })

  it('reports what needs a person', async () => {
    const needsPerson = {
      ...REPORT,
      findings: [{ ...REPORT.findings[0], id: 'RR003', table: 'unknown_table', policy: 'p' }],
    }
    const io = captureIO({ cwd: setup(needsPerson) })
    await run(['fix', '--from', 'report.json', '--db', DB], io, fixDeps())
    expect(io.err()).toContain('unknown_table')
  })
})

describe('loadReport', () => {
  const dir = (): string => tempDir()

  it('reads plain UTF-8', () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'r.json'), JSON.stringify(REPORT))
    expect(loadReport('r.json', cwd).summary.score).toBe(40)
  })

  it('reads UTF-8 with a BOM', () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'r.json'), `﻿${JSON.stringify(REPORT)}`)
    expect(loadReport('r.json', cwd).summary.score).toBe(40)
  })

  it('reads UTF-16, which Windows PowerShell 5.1 writes for `redrow scan --json > report.json`', () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'r.json'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(REPORT), 'utf16le')]))
    expect(loadReport('r.json', cwd).summary.score).toBe(40)
  })

  it('names the file on invalid JSON', () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'r.json'), '{ nope')
    expect(() => loadReport('r.json', cwd)).toThrow(/r\.json.*JSON/)
  })

  // JSON.parse quotes the input it choked on, and --from .env would print part of a secret.
  it('never repeats the contents of a file that is not JSON', () => {
    const cwd = dir()
    writeFileSync(join(cwd, 'r.json'), 'DB_PASSWORD=hunter2hunter2')
    const failure = (() => {
      try {
        loadReport('r.json', cwd)
        return ''
      } catch (error: unknown) {
        return (error as Error).message
      }
    })()
    expect(failure).toMatch(/r\.json/)
    expect(failure).not.toMatch(/hunter2|DB_PASS/)
  })

  it('rejects a grade or score the scanner could not have written', () => {
    const cwd = dir()
    const summary = { ...REPORT.summary, grade: '\u001b]0;pwned\u0007' }
    writeFileSync(join(cwd, 'r.json'), JSON.stringify({ ...REPORT, summary }))
    expect(() => loadReport('r.json', cwd)).toThrow(/grade/)
    writeFileSync(join(cwd, 'r.json'), JSON.stringify({ ...REPORT, summary: { ...REPORT.summary, score: 900 } }))
    expect(() => loadReport('r.json', cwd)).toThrow(/score/)
  })
})

describe('redrow scan --html', () => {
  it('writes the report to the given file, and still exits by the findings', async () => {
    const cwd = tempDir()
    const io = captureIO({ cwd })
    const code = await run(['scan', '--db', DB, '--html', 'out.html'], io, fakeDeps())
    expect(code).toBe(0)
    expect(readFileSync(join(cwd, 'out.html'), 'utf8')).toContain('<!doctype html>')
    expect(io.err()).toContain('out.html')
  })

  it('works alongside --json, keeping stdout valid JSON', async () => {
    const cwd = tempDir()
    const io = captureIO({ cwd })
    await run(['scan', '--db', DB, '--json', '--html', 'out.html'], io, fakeDeps())
    expect(() => JSON.parse(io.out()) as unknown).not.toThrow()
    expect(readFileSync(join(cwd, 'out.html'), 'utf8')).toContain('<!doctype html>')
  })

  it('exits 2 with a clear message when the file cannot be written', async () => {
    const io = captureIO({ cwd: tempDir() })
    expect(await run(['scan', '--db', DB, '--html', 'no/such/dir/out.html'], io, fakeDeps())).toBe(2)
    expect(io.err()).toContain('out.html')
  })
})
