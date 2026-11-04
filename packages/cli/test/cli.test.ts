import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { run } from '../src/cli'
import { captureIO, fakeDeps, resultWith, scanResult } from './helpers'

const LOCAL_DB = 'postgres://u:s3cret@localhost:5432/app'
const PROD_DB = 'postgres://u:s3cret@db.example.com:5432/postgres'
const tempDir = (): string => mkdtempSync(join(tmpdir(), 'redrow-cli-'))

describe('help and usage', () => {
  it('prints scan help and exits 0, with no database and no env', async () => {
    const io = captureIO()
    expect(await run(['scan', '--help'], io, fakeDeps())).toBe(0)
    for (const flag of ['--db', '--config', '--only', '--severity', '--json', '--verbose', '--no-color', '--read-only', '--i-know-what-im-doing']) {
      expect(io.out()).toContain(flag)
    }
  })

  it('exits 2 on an unknown flag', async () => {
    const io = captureIO()
    expect(await run(['scan', '--nope'], io, fakeDeps())).toBe(2)
    expect(io.err()).toContain('--nope')
  })

  it('exits 2 on an unknown command', async () => {
    expect(await run(['explode'], captureIO(), fakeDeps())).toBe(2)
  })

  it('exits 2 when no command is given', async () => {
    expect(await run([], captureIO(), fakeDeps())).toBe(2)
  })

  it('exits 2 on a severity outside the allowed list', async () => {
    const io = captureIO()
    expect(await run(['scan', '--db', LOCAL_DB, '--severity', 'spicy'], io, fakeDeps())).toBe(2)
    expect(io.err()).toContain('spicy')
  })
})

describe('database url', () => {
  it('exits 2 and says how to fix it when there is no url', async () => {
    const io = captureIO()
    const deps = fakeDeps()
    expect(await run(['scan'], io, deps)).toBe(2)
    expect(io.err()).toContain('REDROW_DB_URL')
    expect(deps.calls.connect).toEqual([])
  })

  it('falls back to REDROW_DB_URL', async () => {
    const deps = fakeDeps()
    expect(await run(['scan'], captureIO({ env: { REDROW_DB_URL: LOCAL_DB } }), deps)).toBe(0)
    expect(deps.calls.connect[0]?.database).toBe('app')
  })

  it('prefers --db over the environment', async () => {
    const deps = fakeDeps()
    const env = { REDROW_DB_URL: 'postgres://u:p@localhost/from_env' }
    await run(['scan', '--db', 'postgres://u:p@localhost/from_flag'], captureIO({ env }), deps)
    expect(deps.calls.connect[0]?.database).toBe('from_flag')
  })
})

describe('production guard', () => {
  it('refuses a remote host with an ordinary database name, before connecting', async () => {
    const io = captureIO()
    const deps = fakeDeps()
    expect(await run(['scan', '--db', PROD_DB], io, deps)).toBe(2)
    expect(deps.calls.connect).toEqual([])
    expect(io.err()).toContain('--i-know-what-im-doing')
    expect(io.err()).not.toContain('s3cret')
  })

  it('goes ahead with the flag, and warns', async () => {
    const io = captureIO()
    const deps = fakeDeps()
    expect(await run(['scan', '--db', PROD_DB, '--i-know-what-im-doing'], io, deps)).toBe(0)
    expect(deps.calls.connect).toHaveLength(1)
    expect(io.err()).toMatch(/warning/i)
  })

  it('accepts -y as the short form of the override', async () => {
    const deps = fakeDeps()
    expect(await run(['scan', '--db', PROD_DB, '-y'], captureIO(), deps)).toBe(0)
    expect(deps.calls.connect).toHaveLength(1)
  })

  it('documents -y in the help', async () => {
    const io = captureIO()
    await run(['scan', '--help'], io, fakeDeps())
    expect(io.out()).toContain('-y, --i-know-what-im-doing')
  })

  describe('allowHosts', () => {
    const configured = (allowHosts: readonly string[]) => {
      const cwd = tempDir()
      writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ allowHosts }))
      return cwd
    }

    it('skips the refusal for an exact match, and says why it did', async () => {
      const io = captureIO({ cwd: configured(['db.example.com']) })
      const deps = fakeDeps()
      expect(await run(['scan', '--db', PROD_DB], io, deps)).toBe(0)
      expect(deps.calls.connect).toHaveLength(1)
      expect(io.err()).toContain('allowHosts')
      expect(io.err()).not.toMatch(/warning/i)
    })

    it('still refuses a different host', async () => {
      const io = captureIO({ cwd: configured(['other.example.com']) })
      const deps = fakeDeps()
      expect(await run(['scan', '--db', PROD_DB], io, deps)).toBe(2)
      expect(deps.calls.connect).toEqual([])
    })

    it('refuses a wildcard in the config outright, before connecting', async () => {
      const io = captureIO({ cwd: configured(['*.example.com']) })
      const deps = fakeDeps()
      expect(await run(['scan', '--db', PROD_DB, '-y'], io, deps)).toBe(2)
      expect(deps.calls.connect).toEqual([])
      expect(io.err()).toContain('allowHosts')
    })
  })

  it('cannot be talked past with a query-string host', async () => {
    const io = captureIO()
    const deps = fakeDeps()
    const url = 'postgres://u:s3cret@localhost/app?host=db.example.com'
    expect(await run(['scan', '--db', url], io, deps)).toBe(2)
    expect(deps.calls.connect).toEqual([])
    expect(io.err()).not.toContain('s3cret')
  })

  it('states what a rollback cannot undo, in the banner and the refusal', async () => {
    const banner = captureIO()
    await run(['scan', '--db', LOCAL_DB], banner, fakeDeps())
    expect(banner.err()).toMatch(/sequence/)
    const refusal = captureIO()
    await run(['scan', '--db', PROD_DB], refusal, fakeDeps())
    expect(refusal.err()).toMatch(/sequences/)
    expect(refusal.err()).toMatch(/dblink/)
  })

  it('allows a remote host when the database name says it is safe', async () => {
    const deps = fakeDeps()
    const url = 'postgres://u:p@db.example.com/carenote_demo'
    expect(await run(['scan', '--db', url], captureIO(), deps)).toBe(0)
  })
})

describe('exit codes', () => {
  it.each([
    ['low', 'low', 1],
    ['medium', 'low', 1],
    ['critical', 'critical', 1],
    ['high', 'medium', 1],
    ['low', 'medium', 0],
    ['medium', 'high', 0],
    ['high', 'critical', 0],
  ] as const)('a %s finding at --severity %s exits %i', async (severity, threshold, expected) => {
    const code = await run(
      ['scan', '--db', LOCAL_DB, '--severity', threshold],
      captureIO(),
      fakeDeps(resultWith(severity)),
    )
    expect(code).toBe(expected)
  })

  it.each(['low', 'medium', 'high', 'critical'])('declared exposure alone exits 0 at --severity %s', async (threshold) => {
    const args = ['scan', '--db', LOCAL_DB, '--severity', threshold]
    expect(await run(args, captureIO(), fakeDeps(resultWith('info')))).toBe(0)
  })

  it('does not offer info as a --severity level', async () => {
    const io = captureIO()
    expect(await run(['scan', '--db', LOCAL_DB, '--severity', 'info'], io, fakeDeps())).toBe(2)
  })

  it('defaults to --severity low, so any finding fails', async () => {
    expect(await run(['scan', '--db', LOCAL_DB], captureIO(), fakeDeps(resultWith('low')))).toBe(1)
  })

  it('exits 0 on a clean scan', async () => {
    expect(await run(['scan', '--db', LOCAL_DB], captureIO(), fakeDeps())).toBe(0)
  })

  it('exits 2 when the scan itself fails, and closes the connection', async () => {
    const io = captureIO()
    const deps = fakeDeps(new Error('catalog exploded'))
    expect(await run(['scan', '--db', LOCAL_DB], io, deps)).toBe(2)
    expect(deps.calls.ended).toBe(1)
    expect(io.err()).toContain('catalog exploded')
  })

  it('exits 2 when every probe was inconclusive, because that proves nothing', async () => {
    const io = captureIO()
    const result = scanResult({
      probes: [{ schema: 'public', table: 't', actor: 'anon', action: 'select_all', outcome: 'inconclusive', rowCount: null }],
    })
    expect(await run(['scan', '--db', LOCAL_DB], io, fakeDeps(result))).toBe(2)
    expect(io.err()).toContain('proves nothing')
  })

  it('still exits 0 when only some probes were inconclusive, and warns in the report', async () => {
    const io = captureIO()
    const probe = { schema: 'public', table: 't', actor: 'anon', action: 'select_all', rowCount: null } as const
    const result = scanResult({
      probes: [
        { ...probe, outcome: 'inconclusive' },
        { ...probe, action: 'delete_any', outcome: 'denied' },
      ],
    })
    expect(await run(['scan', '--db', LOCAL_DB], io, fakeDeps(result))).toBe(0)
    expect(io.out()).toContain('1 probe proved nothing')
  })

  it('reports a rendering failure as itself, not as a database error', async () => {
    const io = captureIO()
    const broken = { ...scanResult(), findings: null } as unknown as ReturnType<typeof scanResult>
    expect(await run(['scan', '--db', LOCAL_DB], io, fakeDeps(broken))).toBe(2)
    expect(io.err()).toContain('Unexpected error')
  })

  it('closes the connection after a successful scan too', async () => {
    const deps = fakeDeps()
    await run(['scan', '--db', LOCAL_DB], captureIO(), deps)
    expect(deps.calls.ended).toBe(1)
  })
})

describe('--json', () => {
  it('writes only valid JSON to stdout, with the banner on stderr', async () => {
    const io = captureIO()
    await run(['scan', '--db', LOCAL_DB, '--json'], io, fakeDeps(resultWith('high')))
    const parsed = JSON.parse(io.out()) as { version: number; findings: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.findings).toHaveLength(1)
    expect(io.out()).not.toContain('rolled back')
    expect(io.err()).toContain('rolled back')
  })

  it('reports a failure on stderr and leaves stdout empty', async () => {
    const io = captureIO()
    expect(await run(['scan', '--db', LOCAL_DB, '--json'], io, fakeDeps(new Error('nope')))).toBe(2)
    expect(io.out()).toBe('')
  })

  it('never carries the password or the raw url', async () => {
    const io = captureIO()
    await run(['scan', '--db', LOCAL_DB, '--json'], io, fakeDeps())
    expect(io.out() + io.err()).not.toContain('s3cret')
  })
})

describe('terminal output', () => {
  it('prints the safety banner and the report', async () => {
    const io = captureIO()
    await run(['scan', '--db', LOCAL_DB], io, fakeDeps(resultWith('critical')))
    expect(io.err()).toContain('All write probes run inside transactions that are rolled back.')
    expect(io.out()).toContain('CRITICAL')
  })

  it('uses color when supported', async () => {
    const io = captureIO({ colorSupported: true })
    await run(['scan', '--db', LOCAL_DB], io, fakeDeps(resultWith('critical')))
    expect(io.out()).toContain('\u001b[')
  })

  it('drops color with --no-color', async () => {
    const io = captureIO({ colorSupported: true })
    await run(['scan', '--db', LOCAL_DB, '--no-color'], io, fakeDeps(resultWith('critical')))
    expect(io.out()).not.toContain('\u001b[')
  })

  it('shows every probe with --verbose', async () => {
    const result = scanResult({
      probes: [{ schema: 'public', table: 't', actor: 'anon', action: 'select_all', outcome: 'denied', rowCount: 0 }],
    })
    const io = captureIO()
    await run(['scan', '--db', LOCAL_DB, '--verbose'], io, fakeDeps(result))
    expect(io.out()).toContain('anon:select_all')
  })
})

describe('options passed to the engine', () => {
  const optionsFrom = async (args: readonly string[], cwd = tempDir()): Promise<Record<string, unknown>> => {
    const deps = fakeDeps()
    await run(['scan', '--db', LOCAL_DB, ...args], captureIO({ cwd }), deps)
    return deps.calls.scanOptions[0] as Record<string, unknown>
  }

  it('splits --only on commas and trims', async () => {
    expect((await optionsFrom(['--only', 'a, b,,c'])).tables).toEqual(['a', 'b', 'c'])
  })

  it('passes --read-only through', async () => {
    expect((await optionsFrom(['--read-only'])).readOnly).toBe(true)
  })

  it('leaves writes on by default', async () => {
    expect((await optionsFrom([])).readOnly).toBe(false)
  })

  it('applies a config file found in the working directory', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ tables: ['from_config'], ownerColumns: { t: 'c' } }))
    const options = await optionsFrom([], cwd)
    expect(options.tables).toEqual(['from_config'])
    expect(options.ownerColumns).toEqual({ t: 'c' })
  })

  it('lets --only win over the config tables', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ tables: ['from_config'] }))
    expect((await optionsFrom(['--only', 'x'], cwd)).tables).toEqual(['x'])
  })

  it('reads --config from the given path', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'other.json'), JSON.stringify({ schemas: ['app'] }))
    expect((await optionsFrom(['--config', 'other.json'], cwd)).schemas).toEqual(['app'])
  })

  it('passes publicTables through to the engine', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'redrow.config.json'), JSON.stringify({ publicTables: ['projects'] }))
    expect((await optionsFrom([], cwd)).publicTables).toEqual(['projects'])
  })

  describe('announcing publicTables', () => {
    const scanWith = async (config: object, args: readonly string[] = []) => {
      const cwd = tempDir()
      writeFileSync(join(cwd, 'c.json'), JSON.stringify(config))
      const io = captureIO({ cwd })
      await run(['scan', '--db', LOCAL_DB, '--config', 'c.json', ...args], io, fakeDeps())
      return io
    }

    it('says which file declared which tables, so a cloned config cannot hide findings silently', async () => {
      const io = await scanWith({ publicTables: ['projects', 'plans'] })
      expect(io.err()).toContain('c.json')
      expect(io.err()).toContain('projects, plans')
    })

    it('still says so under --json, on stderr', async () => {
      const io = await scanWith({ publicTables: ['projects'] }, ['--json'])
      expect(io.err()).toContain('projects')
      expect(() => JSON.parse(io.out()) as unknown).not.toThrow()
    })

    it('stays quiet when nothing is declared', async () => {
      expect((await scanWith({})).err()).not.toMatch(/declared/i)
    })

    it('neutralizes control characters in the names it prints', async () => {
      const io = await scanWith({ publicTables: ['a\u001b[31mb'] })
      expect(io.err()).not.toContain('\u001b')
    })
  })

  it('passes tenant fixtures as actors and role fixtures as roles', async () => {
    const cwd = tempDir()
    const userA = '00000000-0000-4000-8000-00000000000a'
    const userB = '00000000-0000-4000-8000-00000000000b'
    writeFileSync(
      join(cwd, 'redrow.config.json'),
      JSON.stringify({ tenants: { userA, userB }, roles: { anon: false } }),
    )
    const options = await optionsFrom([], cwd)
    expect(options.actors).toEqual({ userA, userB })
    expect(options.roles).toEqual({ anon: false, authenticated: true })
  })

  it('exits 2 on a missing --config, before connecting', async () => {
    const io = captureIO({ cwd: tempDir() })
    const deps = fakeDeps()
    expect(await run(['scan', '--db', LOCAL_DB, '--config', 'gone.json'], io, deps)).toBe(2)
    expect(deps.calls.connect).toEqual([])
    expect(io.err()).toContain('gone.json')
  })
})

describe('redrow init', () => {
  it('works with no database and writes a config that scan accepts', async () => {
    const cwd = tempDir()
    const io = captureIO({ cwd })
    expect(await run(['init'], io, fakeDeps())).toBe(0)
    const written = JSON.parse(readFileSync(join(cwd, 'redrow.config.json'), 'utf8')) as Record<string, unknown>
    expect(written).toHaveProperty('tables')
    expect(written).toHaveProperty('roles')
    expect(written).toHaveProperty('tenants')
    expect(await run(['scan', '--db', LOCAL_DB], captureIO({ cwd }), fakeDeps())).toBe(0)
  })

  it('refuses to overwrite, and leaves the file alone', async () => {
    const cwd = tempDir()
    const path = join(cwd, 'redrow.config.json')
    writeFileSync(path, '{"mine":true}')
    const io = captureIO({ cwd })
    expect(await run(['init'], io, fakeDeps())).toBe(2)
    expect(io.err()).toContain('--force')
    expect(readFileSync(path, 'utf8')).toBe('{"mine":true}')
  })

  it('overwrites with --force', async () => {
    const cwd = tempDir()
    const path = join(cwd, 'redrow.config.json')
    writeFileSync(path, '{"mine":true}')
    expect(await run(['init', '--force'], captureIO({ cwd }), fakeDeps())).toBe(0)
    expect(readFileSync(path, 'utf8')).toContain('tenants')
  })
})
