import type { Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scan, toReport } from '../src/index'
import { runTableProbes } from '../src/probes'
import { impersonate, inRolledBackTx } from '../src/tx'
import { table } from './fixtures'
import {
  TEST_DB_URL,
  connectToTestDb,
  connectToTestDbAs,
  readSessionState,
  type SessionState,
} from './integration-db'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const SCHEMA = 'redrow_rollback_it'
const TEMPORARY_ERROR = 'deliberate failure inside a probe'

const FIXTURE = `
  drop schema if exists ${SCHEMA} cascade;
  create schema ${SCHEMA};
  grant usage on schema ${SCHEMA} to anon, authenticated;

  create table ${SCHEMA}.sentinel (id serial primary key, label text not null);
  alter table ${SCHEMA}.sentinel enable row level security;
  create policy anyone on ${SCHEMA}.sentinel for all to authenticated using (true) with check (true);

  -- Leaks: delete policy isn't owner-scoped, insert doesn't check the owner, and there's
  -- an extra NOT NULL column the probe can't fill. Select is owner-scoped, so a probe
  -- using WHERE would see none of this.
  create table ${SCHEMA}.leaky (id serial primary key, user_id uuid not null, extra int not null);
  alter table ${SCHEMA}.leaky enable row level security;
  create policy r on ${SCHEMA}.leaky for select to authenticated using (user_id = (select auth.uid()));
  create policy d on ${SCHEMA}.leaky for delete to authenticated using (true);
  create policy i on ${SCHEMA}.leaky for insert to authenticated with check (true);
  create policy u on ${SCHEMA}.leaky for update to authenticated using (true) with check (true);
  create index on ${SCHEMA}.leaky (user_id);

  -- Everything scoped to the owner: must come back clean.
  create table ${SCHEMA}.safe (id serial primary key, user_id uuid not null, note text);
  alter table ${SCHEMA}.safe enable row level security;
  create policy o on ${SCHEMA}.safe for all to authenticated
    using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  create index on ${SCHEMA}.safe (user_id);

  -- Open SELECT, and an UPDATE that rejects B's row staying B's but lets A claim any row.
  create table ${SCHEMA}.takeover (id serial primary key, user_id uuid not null);
  alter table ${SCHEMA}.takeover enable row level security;
  create policy r on ${SCHEMA}.takeover for select to authenticated using (true);
  create policy u on ${SCHEMA}.takeover for update to authenticated
    using (true) with check (user_id = (select auth.uid()));
  create index on ${SCHEMA}.takeover (user_id);

  grant all on all tables in schema ${SCHEMA} to anon, authenticated;
  grant all on all sequences in schema ${SCHEMA} to anon, authenticated;

  insert into ${SCHEMA}.takeover (user_id) select '${A}' from generate_series(1, 2);
  insert into ${SCHEMA}.takeover (user_id) select '${B}' from generate_series(1, 3);

  insert into ${SCHEMA}.leaky (user_id, extra) select '${A}', g from generate_series(1, 3) g;
  insert into ${SCHEMA}.leaky (user_id, extra) select '${B}', g from generate_series(1, 5) g;
  insert into ${SCHEMA}.safe (user_id, note) select '${A}', 'a' from generate_series(1, 2);
  insert into ${SCHEMA}.safe (user_id, note) select '${B}', 'b' from generate_series(1, 4);
`

describe.skipIf(TEST_DB_URL === undefined)('rollback safety, against a real database', () => {
  let admin: Sql
  let baseline: SessionState

  const sentinelRows = async (client: Sql): Promise<number> => {
    const rows = await client<{ n: number }[]>`select count(*)::int as n from ${client(SCHEMA)}.sentinel`
    return rows[0]?.n ?? -1
  }

  /** Asserts from a brand-new connection, so nothing session-local can hide a leak. */
  const expectNoResidue = async (): Promise<void> => {
    const fresh = connectToTestDb()
    try {
      expect(await sentinelRows(fresh)).toBe(0)
      expect(await readSessionState(fresh)).toEqual(baseline)
    } finally {
      await fresh.end()
    }
  }

  beforeAll(async () => {
    admin = connectToTestDb()
    await admin.unsafe(FIXTURE)
    baseline = await readSessionState(admin)
    expect(baseline.claims).toBeNull()
  })

  afterAll(async () => {
    await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`)
    await admin.end()
  })

  it('removes a sentinel row a probe really inserted, and restores role and claims', async () => {
    let seenInside = -1
    let identityInside: SessionState | undefined
    await inRolledBackTx(admin, async (tx) => {
      await impersonate(tx, 'authenticated', A)
      await tx`insert into ${tx(SCHEMA)}.sentinel (label) values ('sentinel')`
      seenInside = await sentinelRows(tx as unknown as Sql)
      identityInside = await readSessionState(tx as unknown as Sql)
    })

    // Inside, the row existed and the identity had changed, so the checks below mean something.
    expect(seenInside).toBe(1)
    expect(identityInside?.role).toBe('authenticated')
    expect(identityInside?.sub).toBe(A)
    await expectNoResidue()
  })

  it('restores state on the same pooled connection, not just on a new one', async () => {
    const single = connectToTestDb(1)
    try {
      const before = await readSessionState(single)
      await inRolledBackTx(single, (tx) => impersonate(tx, 'anon'))
      expect(await readSessionState(single)).toEqual(before)
    } finally {
      await single.end()
    }
  })

  it('leaves no residue when a probe throws after writing, and rethrows the error', async () => {
    await expect(
      inRolledBackTx(admin, async (tx) => {
        await impersonate(tx, 'authenticated', A)
        await tx`insert into ${tx(SCHEMA)}.sentinel (label) values ('sentinel')`
        throw new Error(TEMPORARY_ERROR)
      }),
    ).rejects.toThrow(TEMPORARY_ERROR)
    await expectNoResidue()
  })

  it('leaves no residue when the server rejects a statement mid-probe', async () => {
    await expect(
      inRolledBackTx(admin, async (tx) => {
        await impersonate(tx, 'authenticated', A)
        await tx`insert into ${tx(SCHEMA)}.sentinel (label) values ('sentinel')`
        await tx`insert into ${tx(SCHEMA)}.sentinel (label) values (null)`
      }),
    ).rejects.toMatchObject({ code: '23502' })
    await expectNoResidue()
  })

  it('releases its connection on success and on failure, so a one-connection pool keeps working', async () => {
    const single = connectToTestDb(1)
    try {
      await inRolledBackTx(single, async (tx) => tx`select 1`)
      await expect(
        inRolledBackTx(single, async () => {
          throw new Error(TEMPORARY_ERROR)
        }),
      ).rejects.toThrow(TEMPORARY_ERROR)
      await expect(single`select 1 as ok`).resolves.toMatchObject([{ ok: 1 }])
    } finally {
      await single.end()
    }
  })

  it('stops a statement that would hang, with the statement timeout', async () => {
    const started = Date.now()
    await expect(
      inRolledBackTx(admin, async (tx) => tx`select pg_sleep(30)`),
    ).rejects.toMatchObject({ code: '57014' })
    expect(Date.now() - started).toBeLessThan(8000)
  }, 12000)

  describe('a full scan', () => {
    const fingerprint = async (client: Sql): Promise<unknown> =>
      client`
        select (select count(*)::int from ${client(SCHEMA)}.leaky) as leaky,
               (select count(*)::int from ${client(SCHEMA)}.leaky where user_id = ${B}) as leaky_b,
               (select md5(string_agg(id::text || user_id::text || extra::text, ',' order by id)) from ${client(SCHEMA)}.leaky) as leaky_hash,
               (select count(*)::int from ${client(SCHEMA)}.safe) as safe,
               (select md5(string_agg(id::text || user_id::text, ',' order by id)) from ${client(SCHEMA)}.safe) as safe_hash,
               (select count(*)::int from ${client(SCHEMA)}.sentinel) as sentinel`

    it('changes nothing, and proves the leaks with counts', async () => {
      const client = connectToTestDb(5)
      try {
        const before = await fingerprint(admin)
        const result = await scan(client, { schemas: [SCHEMA], actors: { userA: A, userB: B } })
        expect(await fingerprint(admin)).toEqual(before)

        const onLeaky = result.findings.filter((f) => f.table === 'leaky')
        const rule = (id: string) => onLeaky.find((f) => f.ruleId === id)
        // WHERE owner = B returns 0 here, because the SELECT policy hides B's rows.
        expect(rule('RR104')).toMatchObject({ rowsExposed: 5 })
        expect(rule('RR103')).toMatchObject({ rowsExposed: 5 })
        // Only the missing NOT NULL column stopped this insert, after RLS let it through.
        expect(rule('RR105')).toBeDefined()
        expect(rule('RR102')).toBeUndefined()

        // Only the re-own shows this. The qualified update is refused by WITH CHECK.
        const takeover = result.findings.find((f) => f.table === 'takeover' && f.ruleId === 'RR103')
        expect(takeover).toMatchObject({ rowsExposed: 3 })

        expect(result.findings.filter((f) => f.table === 'safe')).toEqual([])
        expect(() => JSON.stringify(toReport(result))).not.toThrow()
      } finally {
        await client.end()
      }
    }, 30000)

    it('has the database itself refuse writes in a read-only transaction', async () => {
      await expect(
        inRolledBackTx(admin, async (tx) => tx`insert into ${tx(SCHEMA)}.sentinel (label) values ('x')`, {
          readOnly: true,
        }),
      ).rejects.toMatchObject({ code: '25006' })
      await expectNoResidue()
    })

    it('fails, rather than reporting clean, when the connecting role cannot become anon', async () => {
      // Unique per run: Supabase's pooler caches logins by name, so reusing one fails at login.
      const password = crypto.randomUUID()
      const name = `redrow_it_${password.replaceAll('-', '').slice(0, 12)}`
      await admin.unsafe(`create role ${name} login password '${password}' noinherit`)
      await admin.unsafe(`grant usage on schema ${SCHEMA} to ${name}`)
      await admin.unsafe(`grant select on all tables in schema ${SCHEMA} to ${name}`)
      const limited = connectToTestDbAs(name, password)
      try {
        // Probes directly, not scan(): Supabase's postgres role can't grant the `auth` schema
        // access that introspection needs, and the role switch is what's being proved here.
        await expect(
          runTableProbes(limited, table('sentinel', { schema: SCHEMA }), { userA: A, userB: B }, {
            readOnly: true,
            anon: true,
            authenticated: false,
          }),
        ).rejects.toThrow(/can't act as anon/)
      } finally {
        await limited.end()
        await admin.unsafe(`revoke all on all tables in schema ${SCHEMA} from ${name}`)
        await admin.unsafe(`revoke all on schema ${SCHEMA} from ${name}`)
        await admin.unsafe(`drop role ${name}`)
      }
    }, 30000)

    it('sends no write at all in read-only mode', async () => {
      const client = connectToTestDb(5)
      try {
        const result = await scan(client, { schemas: [SCHEMA], readOnly: true, actors: { userA: A, userB: B } })
        const writes = ['update_other', 'delete_other', 'insert_other', 'update_any', 'delete_any']
        expect(result.probes.filter((p) => writes.includes(p.action))).toEqual([])
      } finally {
        await client.end()
      }
    }, 30000)
  })
})
