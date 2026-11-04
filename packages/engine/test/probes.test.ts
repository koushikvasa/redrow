import { describe, expect, it } from 'vitest'
import { gatherTableStats, runTableProbes } from '../src/probes'
import { ImpersonationError, impersonate, inRolledBackTx } from '../src/tx'
import type { Actors, ProbeResult } from '../src/types'
import { fakeSql, serverError, type FakeSql } from './fake-sql'
import { column, table } from './fixtures'

const ACTORS: Actors = {
  userA: '00000000-0000-4000-8000-00000000000a',
  userB: '00000000-0000-4000-8000-00000000000b',
}

const owned = table('t', { ownerColumn: 'user_id', columns: [column('user_id')] })
const unowned = table('t', { columns: [column('id', { writable: false }), column('label', { type: 'text' })] })

const find = (probes: readonly ProbeResult[], actor: string, action: string): ProbeResult => {
  const match = probes.find((p) => p.actor === actor && p.action === action)
  expect(match, `${actor}:${action}`).toBeDefined()
  return match as ProbeResult
}

const rows = (count: number): object[] => Array.from({ length: count }, () => ({}))
const countRow = (n: number): object[] => [{ n }]

describe('inRolledBackTx', () => {
  it('returns the callback value and rolls back rather than committing', async () => {
    const sql = fakeSql()
    await expect(inRolledBackTx(sql.client, async () => 'done')).resolves.toBe('done')
    expect(sql.transactions).toMatchObject({ rolledBack: 1, committed: 0 })
  })

  it('uses repeatable read, so before and after counts are comparable', async () => {
    const sql = fakeSql()
    await inRolledBackTx(sql.client, async () => 'done')
    expect(sql.transactions.modes).toEqual(['isolation level repeatable read'])
  })

  it('asks the database to refuse writes when read-only', async () => {
    const sql = fakeSql()
    await inRolledBackTx(sql.client, async () => 'done', { readOnly: true })
    expect(sql.transactions.modes).toEqual(['isolation level repeatable read read only'])
  })

  it('rethrows a failure from the callback, still without committing', async () => {
    const sql = fakeSql()
    const failure = new Error('boom')
    await expect(
      inRolledBackTx(sql.client, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(sql.transactions).toMatchObject({ rolledBack: 1, committed: 0 })
  })

  it('sets the statement and lock timeouts before running anything', async () => {
    const sql = fakeSql()
    await inRolledBackTx(sql.client, async (tx) => tx`select 1`)
    expect(sql.queries.map((q) => q.text)).toEqual([
      "set local statement_timeout = '5s'",
      "set local lock_timeout = '1s'",
      'select 1',
    ])
  })
})

describe('impersonate', () => {
  it('sets the role and every claim form, all transaction-local', async () => {
    const sql = fakeSql()
    await inRolledBackTx(sql.client, (tx) => impersonate(tx, 'authenticated', ACTORS.userA))
    const queries = sql.queries.slice(2)
    expect(queries[0]?.text).toBe('set local role authenticated')
    expect(queries[1]?.text).toContain("set_config('request.jwt.claims', ?, true)")
    expect(queries[1]?.text).toContain("set_config('request.jwt.claim.sub', ?, true)")
    expect(queries[1]?.text).toContain("set_config('request.jwt.claim.role', ?, true)")
    expect(queries[1]?.values).toEqual([
      JSON.stringify({ sub: ACTORS.userA, role: 'authenticated' }),
      ACTORS.userA,
      'authenticated',
    ])
  })

  it('gives anon an empty sub and no sub claim', async () => {
    const sql = fakeSql()
    await inRolledBackTx(sql.client, (tx) => impersonate(tx, 'anon'))
    expect(sql.queries[3]?.values).toEqual([JSON.stringify({ role: 'anon' }), '', 'anon'])
  })

  it('refuses any role outside the whitelist, before running SQL', async () => {
    const sql = fakeSql()
    await expect(
      inRolledBackTx(sql.client, (tx) => impersonate(tx, 'postgres; drop table t' as 'anon')),
    ).rejects.toThrow(/role/i)
    expect(sql.queries.some((q) => q.text.includes('drop table'))).toBe(false)
  })

  it('raises ImpersonationError when the role switch is refused, rather than a SQLSTATE', async () => {
    const sql = fakeSql({
      respond: (text) => (text.startsWith('set local role') ? serverError('42501', 'permission denied to set role') : undefined),
    })
    const rejection = inRolledBackTx(sql.client, (tx) => impersonate(tx, 'anon'))
    await expect(rejection).rejects.toBeInstanceOf(ImpersonationError)
    await expect(rejection).rejects.not.toHaveProperty('code')
    await expect(rejection).rejects.toThrow(/permission denied to set role/)
  })
})

describe('runTableProbes', () => {
  const run = (sql: FakeSql, target = owned, readOnly = false) =>
    runTableProbes(sql.client, target, ACTORS, { readOnly, anon: true, authenticated: true })

  it('commits nothing across a full run, even with every probe erroring', async () => {
    const sql = fakeSql({ respond: (text) => (text.startsWith('set local') ? undefined : serverError('42501')) })
    await run(sql)
    expect(sql.transactions.committed).toBe(0)
    expect(sql.transactions.rolledBack).toBeGreaterThan(0)
  })

  it('runs each probe in its own transaction, with at most one identity per transaction', async () => {
    const sql = fakeSql()
    await run(sql)
    const texts = sql.queries.map((q) => q.text)
    const perTransaction = texts
      .join('\n')
      .split("set local statement_timeout = '5s'")
      .slice(1)
    expect(perTransaction).toHaveLength(sql.transactions.rolledBack)
    for (const body of perTransaction) {
      const switches = body.split('\n').filter((t) => /^set local role (anon|authenticated)$/.test(t))
      expect(switches.length).toBeLessThanOrEqual(1)
    }
  })

  it('never selects row contents', async () => {
    const sql = fakeSql()
    await run(sql)
    for (const query of sql.queries) {
      expect(query.text).not.toMatch(/select\s+\*/i)
      expect(query.text).not.toMatch(/returning/i)
    }
  })

  it('quotes identifiers through the driver helper', async () => {
    const sql = fakeSql()
    await run(sql, table('Order"s', { ownerColumn: 'user_id', columns: [column('user_id')] }))
    expect(sql.queries.some((q) => q.text.includes('from "public"."Order"s"'))).toBe(true)
  })

  it('maps a visible count to allowed and zero to denied', async () => {
    const sql = fakeSql({
      respond: (text) => {
        if (text.includes('is distinct from')) return countRow(5)
        if (text.includes('= ?')) return countRow(0)
        if (text.startsWith('select count(*)')) return countRow(7)
        return undefined
      },
    })
    const probes = await run(sql, owned, true)
    expect(find(probes, 'user_a', 'select_others')).toMatchObject({ outcome: 'allowed', rowCount: 5 })
    expect(find(probes, 'user_a', 'select_own')).toMatchObject({ outcome: 'denied', rowCount: 0 })
    expect(find(probes, 'anon', 'select_all')).toMatchObject({ outcome: 'allowed', rowCount: 7 })
  })

  it('maps SQLSTATE 42501 to denied', async () => {
    const sql = fakeSql({ respond: (text) => (text.includes('count(*)') ? serverError('42501') : undefined) })
    const probes = await run(sql, owned, true)
    expect(find(probes, 'anon', 'select_all')).toMatchObject({ outcome: 'denied', rowCount: null })
  })

  it('maps a statement timeout to inconclusive rather than failing the scan', async () => {
    const sql = fakeSql({ respond: (text) => (text.includes('count(*)') ? serverError('57014') : undefined) })
    const probes = await run(sql, owned, true)
    expect(find(probes, 'anon', 'select_all')).toMatchObject({ outcome: 'inconclusive', rowCount: null })
  })

  it('lets a lost connection fail the scan rather than pass as a clean result', async () => {
    const lost = Object.assign(new Error('gone'), { code: 'CONNECTION_ENDED' })
    await expect(run(fakeSql({ failWith: lost }))).rejects.toBe(lost)
  })

  it('fails the scan when a role cannot be assumed, because all-denied would look safe', async () => {
    const sql = fakeSql({
      respond: (text) => (text.startsWith('set local role') ? serverError('42501') : undefined),
    })
    await expect(run(sql, owned, true)).rejects.toBeInstanceOf(ImpersonationError)
  })

  it.each(['55P03', '40P01', '40001'])('retries once on contention error %s', async (code) => {
    let failuresLeft = 1
    const sql = fakeSql({
      respond: (text) => {
        if (!text.includes('count(*)') || failuresLeft === 0) return undefined
        failuresLeft -= 1
        return serverError(code)
      },
    })
    const probes = await run(sql, owned, true)
    expect(find(probes, 'anon', 'select_all')).toMatchObject({ outcome: 'denied', rowCount: 0 })
  })

  it('gives up as inconclusive when contention persists', async () => {
    const sql = fakeSql({
      respond: (text) => (text.includes('count(*)') ? serverError('55P03') : undefined),
    })
    const probes = await run(sql, owned, true)
    expect(find(probes, 'anon', 'select_all')).toMatchObject({ outcome: 'inconclusive', rowCount: null })
  })

  it.each([
    ['table', table('a.b', { columns: [column('c')] })],
    ['schema', table('t', { schema: 'a.b', columns: [column('c')] })],
    ['owner column', table('t', { ownerColumn: 'a.b', columns: [column('a.b')] })],
  ])('sends no SQL for a %s name with a dot, and marks every probe inconclusive', async (_label, target) => {
    const sql = fakeSql()
    const probes = await run(sql, target)
    expect(sql.queries).toEqual([])
    expect(probes.length).toBeGreaterThan(0)
    expect(probes.every((p) => p.outcome === 'inconclusive')).toBe(true)
  })

  it('skips a dotted column when choosing one to update', async () => {
    const sql = fakeSql()
    await run(sql, table('t', { columns: [column('a.b'), column('c')] }))
    expect(sql.queries.some((q) => q.text.includes('set "c" = "c"'))).toBe(true)
  })

  it('runs read probes in read-only transactions in read-only mode', async () => {
    const sql = fakeSql()
    await run(sql, owned, true)
    expect(sql.transactions.modes.length).toBeGreaterThan(0)
    expect(sql.transactions.modes.every((mode) => mode.endsWith('read only'))).toBe(true)
  })

  describe('read-only mode', () => {
    it('sends no write statement at all', async () => {
      const sql = fakeSql()
      await run(sql, owned, true)
      for (const query of sql.queries) {
        expect(query.text).not.toMatch(/^\s*(insert|update|delete)\b/i)
      }
    })

    it('still runs the read probes', async () => {
      const probes = await run(fakeSql(), owned, true)
      expect(probes.map((p) => `${p.actor}:${p.action}`)).toEqual([
        'anon:select_all',
        'user_a:select_own',
        'user_a:select_others',
      ])
    })
  })

  it('runs the full set when writes are allowed', async () => {
    const probes = await run(fakeSql())
    expect(probes.map((p) => `${p.actor}:${p.action}`)).toEqual([
      'anon:select_all',
      'anon:update_any',
      'anon:delete_any',
      'anon:insert_other',
      'user_a:select_own',
      'user_a:select_others',
      'user_a:update_other',
      'user_a:delete_other',
      'user_a:insert_other',
    ])
  })

  it('skips a role that is switched off', async () => {
    const onlyAnon = await runTableProbes(fakeSql().client, owned, ACTORS, {
      readOnly: true,
      anon: true,
      authenticated: false,
    })
    expect(onlyAnon.map((p) => p.actor)).toEqual(['anon'])
    const onlyUsers = await runTableProbes(fakeSql().client, owned, ACTORS, {
      readOnly: true,
      anon: false,
      authenticated: true,
    })
    expect(onlyUsers.every((p) => p.actor === 'user_a')).toBe(true)
  })

  it('probes an un-owned table with select_all as user A and no cross-user writes', async () => {
    const probes = await run(fakeSql(), unowned)
    expect(probes.map((p) => `${p.actor}:${p.action}`)).toEqual([
      'anon:select_all',
      'anon:update_any',
      'anon:delete_any',
      'anon:insert_other',
      'user_a:select_all',
    ])
  })

  describe('anon update', () => {
    it('assigns the owner column to itself when there is one', async () => {
      const sql = fakeSql()
      await run(sql)
      expect(sql.queries.some((q) => q.text.includes('set "user_id" = "user_id"'))).toBe(true)
    })

    it('skips generated and identity columns, which would fail on every table', async () => {
      const sql = fakeSql()
      await run(sql, unowned)
      expect(sql.queries.some((q) => q.text.includes('set "label" = "label"'))).toBe(true)
    })

    it('is not applicable when no column can be assigned', async () => {
      const target = table('t', { columns: [column('id', { writable: false })] })
      const probes = await run(fakeSql(), target)
      expect(find(probes, 'anon', 'update_any')).toMatchObject({ outcome: 'not_applicable', rowCount: null })
    })
  })

  describe('delete_other', () => {
    it('deletes with no WHERE, because a WHERE would pull in the SELECT policy and hide the leak', async () => {
      const sql = fakeSql({
        respond: (text) => (text.includes('is distinct from') ? countRow(2) : undefined),
      })
      await run(sql)
      const statements = sql.queries.filter((q) => q.text.startsWith('delete from'))
      expect(statements.every((q) => q.text === 'delete from "public"."t"')).toBe(true)
    })

    it('counts the rows that vanished', async () => {
      const probes = await run(fakeSql({
        respond: (() => {
          let phase: 'before' | 'after' = 'before'
          return (text: string) => {
            if (text.startsWith('delete from')) phase = 'after'
            if (text.startsWith('set local statement_timeout')) phase = 'before'
            if (text.includes('is distinct from')) return countRow(phase === 'before' ? 4 : 1)
            return undefined
          }
        })(),
      }))
      expect(find(probes, 'user_a', 'delete_other')).toMatchObject({ outcome: 'allowed', rowCount: 3 })
    })

    it('is not applicable when no other user has rows', async () => {
      const probes = await run(fakeSql())
      expect(find(probes, 'user_a', 'delete_other')).toMatchObject({ outcome: 'not_applicable', rowCount: 0 })
    })

    it('is inconclusive when a foreign key blocks the statement', async () => {
      const probes = await run(fakeSql({
        respond: (text) => {
          if (text.startsWith('delete from')) return serverError('23503')
          if (text.includes('is distinct from')) return countRow(2)
          return undefined
        },
      }))
      expect(find(probes, 'user_a', 'delete_other')).toMatchObject({ outcome: 'inconclusive', rowCount: null })
    })
  })

  describe('update_other', () => {
    it('reports the qualified update first when it affects rows', async () => {
      const probes = await run(fakeSql({
        respond: (text) => (text.startsWith('update') && text.includes('where') ? rows(3) : undefined),
      }))
      expect(find(probes, 'user_a', 'update_other')).toMatchObject({ outcome: 'allowed', rowCount: 3 })
    })

    it('falls back to an unqualified re-own, which a SELECT policy cannot hide', async () => {
      const probes = await run(fakeSql({
        respond: (() => {
          let phase: 'before' | 'after' = 'before'
          return (text: string) => {
            if (text.startsWith('update') && !text.includes('where') && text.includes('= ?')) phase = 'after'
            if (text.startsWith('set local statement_timeout')) phase = 'before'
            if (text.includes('is distinct from')) return countRow(phase === 'before' ? 5 : 0)
            return undefined
          }
        })(),
      }))
      expect(find(probes, 'user_a', 'update_other')).toMatchObject({ outcome: 'allowed', rowCount: 5 })
    })

    it('still tries the re-own when WITH CHECK rejects the qualified update', async () => {
      // `using (true) with check (owner = auth.uid())`: B's row can't stay B's, but A can claim it.
      const probes = await run(fakeSql({
        respond: (() => {
          let phase: 'before' | 'after' = 'before'
          return (text: string) => {
            const qualified = text.startsWith('update') && text.includes('where')
            if (qualified) return serverError('42501')
            if (text.startsWith('update') && text.includes('= ?')) phase = 'after'
            if (text.startsWith('set local statement_timeout')) phase = 'before'
            if (text.includes('is distinct from')) return countRow(phase === 'before' ? 5 : 0)
            return undefined
          }
        })(),
      }))
      expect(find(probes, 'user_a', 'update_other')).toMatchObject({ outcome: 'allowed', rowCount: 5 })
    })

    it('is denied when both the qualified update and the re-own are refused', async () => {
      const sql = fakeSql({
        respond: (text) => {
          if (text.startsWith('update')) return serverError('42501')
          return text.includes('is distinct from') ? countRow(5) : undefined
        },
      })
      const probes = await run(sql)
      expect(find(probes, 'user_a', 'update_other')).toMatchObject({ outcome: 'denied', rowCount: null })
    })
  })

  describe('insert_other', () => {
    it.each(['23502', '23503', '23505', '23514', '23P01'])(
      'treats constraint error %s as allowed, because RLS is checked before constraints',
      async (code) => {
        const probes = await run(fakeSql({
          respond: (text) => (text.startsWith('insert') ? serverError(code) : undefined),
        }))
        expect(find(probes, 'user_a', 'insert_other')).toMatchObject({ outcome: 'allowed', rowCount: null })
      },
    )

    it('treats 42501 as denied', async () => {
      const probes = await run(fakeSql({
        respond: (text) => (text.startsWith('insert') ? serverError('42501') : undefined),
      }))
      expect(find(probes, 'user_a', 'insert_other')).toMatchObject({ outcome: 'denied', rowCount: null })
    })

    it('treats any other error, such as a trigger raising, as inconclusive', async () => {
      const probes = await run(fakeSql({
        respond: (text) => (text.startsWith('insert') ? serverError('P0001') : undefined),
      }))
      expect(find(probes, 'user_a', 'insert_other')).toMatchObject({ outcome: 'inconclusive', rowCount: null })
    })

    it('is allowed when a row owned by B actually appears', async () => {
      const probes = await run(fakeSql({
        respond: (() => {
          let inserted = false
          return (text: string) => {
            if (text.startsWith('set local statement_timeout')) inserted = false
            if (text.startsWith('insert')) inserted = true
            if (text.includes('= ?') && text.startsWith('select count')) return countRow(inserted ? 3 : 2)
            return undefined
          }
        })(),
      }))
      expect(find(probes, 'user_a', 'insert_other')).toMatchObject({ outcome: 'allowed', rowCount: 1 })
    })

    it('is denied when a trigger rewrote the owner, so no row owned by B appeared', async () => {
      const probes = await run(fakeSql())
      expect(find(probes, 'user_a', 'insert_other')).toMatchObject({ outcome: 'denied', rowCount: 0 })
    })

    it('uses default values on an un-owned table', async () => {
      const sql = fakeSql()
      const probes = await run(sql, unowned)
      expect(sql.queries.some((q) => q.text.endsWith('default values'))).toBe(true)
      expect(find(probes, 'anon', 'insert_other')).toMatchObject({ outcome: 'allowed', rowCount: 1 })
    })
  })
})

describe('gatherTableStats', () => {
  it('reads the total and top owners without reading any other column', async () => {
    const sql = fakeSql({
      rowsByQuery: {
        'group by': [{ owner: ACTORS.userA, n: 3 }],
        'count(*)::int as n from': [{ n: 9 }],
      },
    })
    const stats = await gatherTableStats(sql.client, owned)
    expect(stats.total).toBe(9)
    expect([...stats.owners]).toEqual([{ owner: ACTORS.userA, n: 3 }])
    expect(sql.transactions.committed).toBe(0)
  })

  it('needs no owner query for an un-owned table', async () => {
    const sql = fakeSql({ rowsByQuery: { 'count(*)::int as n': [{ n: 9 }] } })
    expect(await gatherTableStats(sql.client, unowned)).toEqual({ total: 9, owners: [] })
    expect(sql.queries.some((q) => q.text.includes('group by'))).toBe(false)
  })

  it('reads nothing from a table whose name it cannot safely address', async () => {
    const sql = fakeSql()
    expect(await gatherTableStats(sql.client, table('a.b'))).toEqual({ total: null, owners: [] })
    expect(sql.queries).toEqual([])
  })

  it('reports a null total when the table is too big to count in time', async () => {
    const sql = fakeSql({ respond: (text) => (text.includes('count(*)') ? serverError('57014') : undefined) })
    expect(await gatherTableStats(sql.client, unowned)).toEqual({ total: null, owners: [] })
  })
})
