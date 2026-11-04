import type { Sql, TransactionSql } from 'postgres'
import type { OwnerCount } from './actors'
import { impersonate, inRolledBackTx, sqlStateOf, stopImpersonating, type ProbeRole } from './tx'
import type {
  Actors,
  ProbeAction,
  ProbeActor,
  ProbeOutcome,
  ProbeResult,
  TableInfo,
} from './types'

const INSUFFICIENT_PRIVILEGE = '42501'

// Postgres checks RLS WITH CHECK before these constraints. So one of them means RLS let
// the row through and a complete row would succeed, where a denial would have been 42501.
const CONSTRAINTS_CHECKED_AFTER_RLS: ReadonlySet<string> = new Set([
  '23502', // not_null_violation
  '23503', // foreign_key_violation
  '23505', // unique_violation
  '23514', // check_violation
  '23P01', // exclusion_violation
])

// Another probe or session got in the way, which says nothing about the policy.
const WORTH_RETRYING: ReadonlySet<string> = new Set([
  '55P03', // lock_not_available
  '40P01', // deadlock_detected
  '40001', // serialization_failure
])

const RETRIES_AFTER_CONTENTION = 1

interface Measurement {
  readonly outcome: ProbeOutcome
  readonly rowCount: number | null
}

interface PlannedProbe {
  readonly actor: ProbeActor
  readonly action: ProbeAction
  readonly run: () => Promise<Measurement>
}

export interface ProbeSettings {
  readonly readOnly: boolean
  readonly anon: boolean
  readonly authenticated: boolean
}

export interface TableStats {
  readonly total: number | null
  readonly owners: readonly OwnerCount[]
}

const allowedIfAny = (n: number): Measurement => ({ outcome: n > 0 ? 'allowed' : 'denied', rowCount: n })

const INCONCLUSIVE: Measurement = { outcome: 'inconclusive', rowCount: null }

/**
 * The driver's identifier helper turns `a.b` into `"a"."b"`, so a name holding a dot would
 * address something else. Such a table isn't probed, and the scan warns about it.
 */
export const isProbeable = (t: TableInfo): boolean =>
  ![t.schema, t.table, t.ownerColumn ?? ''].some((name) => name.includes('.'))

async function measure(
  run: () => Promise<Measurement>,
  classify: (state: string) => ProbeOutcome = () => 'inconclusive',
  retries: number = RETRIES_AFTER_CONTENTION,
): Promise<Measurement> {
  try {
    return await run()
  } catch (error: unknown) {
    const state = sqlStateOf(error)
    if (state === undefined) throw error
    if (WORTH_RETRYING.has(state) && retries > 0) return measure(run, classify, retries - 1)
    return { outcome: state === INSUFFICIENT_PRIVILEGE ? 'denied' : classify(state), rowCount: null }
  }
}

const classifyInsertError = (state: string): ProbeOutcome =>
  CONSTRAINTS_CHECKED_AFTER_RLS.has(state) ? 'allowed' : 'inconclusive'

const firstCount = (rows: readonly { n: number }[]): number => rows[0]?.n ?? 0

async function countAll(tx: TransactionSql, t: TableInfo): Promise<number> {
  return firstCount(await tx<{ n: number }[]>`select count(*)::int as n from ${tx(t.schema)}.${tx(t.table)}`)
}

async function countOwnedBy(tx: TransactionSql, t: TableInfo, owner: string, id: string): Promise<number> {
  return firstCount(
    await tx<{ n: number }[]>`select count(*)::int as n from ${tx(t.schema)}.${tx(t.table)} where ${tx(owner)} = ${id}`,
  )
}

async function countNotOwnedBy(tx: TransactionSql, t: TableInfo, owner: string, id: string): Promise<number> {
  return firstCount(
    await tx<{ n: number }[]>`select count(*)::int as n from ${tx(t.schema)}.${tx(t.table)} where ${tx(owner)} is distinct from ${id}`,
  )
}

function asCaller<T>(
  sql: Sql,
  role: ProbeRole,
  sub: string | undefined,
  fn: (tx: TransactionSql) => Promise<T>,
  readOnly = false,
): Promise<T> {
  return inRolledBackTx(
    sql,
    async (tx) => {
      await impersonate(tx, role, sub)
      return fn(tx)
    },
    { readOnly },
  )
}

/**
 * How many of other users' rows `mutate` removed from their ownership, measured as the
 * connecting role before and after. A mutation with no WHERE is what makes this honest:
 * a WHERE on a column also applies the SELECT policy, which hides rows the caller could
 * still destroy with a plain `delete from t`.
 */
function othersAffected(
  sql: Sql,
  t: TableInfo,
  owner: string,
  userA: string,
  mutate: (tx: TransactionSql) => Promise<unknown>,
): Promise<Measurement> {
  return inRolledBackTx(sql, async (tx) => {
    const before = await countNotOwnedBy(tx, t, owner, userA)
    if (before === 0) return { outcome: 'not_applicable', rowCount: 0 }
    await impersonate(tx, 'authenticated', userA)
    await mutate(tx)
    await stopImpersonating(tx)
    return allowedIfAny(before - (await countNotOwnedBy(tx, t, owner, userA)))
  })
}

/** Measures rather than trusts: a BEFORE trigger may have rewritten the owner to the caller. */
function insertOwnedBy(
  sql: Sql,
  t: TableInfo,
  owner: string,
  ownerId: string,
  role: ProbeRole,
  sub: string | undefined,
): Promise<Measurement> {
  return measure(
    () =>
      inRolledBackTx(sql, async (tx) => {
        const before = await countOwnedBy(tx, t, owner, ownerId)
        await impersonate(tx, role, sub)
        await tx`insert into ${tx(t.schema)}.${tx(t.table)} (${tx(owner)}) values (${ownerId})`
        await stopImpersonating(tx)
        return allowedIfAny((await countOwnedBy(tx, t, owner, ownerId)) - before)
      }),
    classifyInsertError,
  )
}

function insertDefaults(sql: Sql, t: TableInfo): Promise<Measurement> {
  return measure(
    () =>
      asCaller(sql, 'anon', undefined, async (tx) => {
        await tx`insert into ${tx(t.schema)}.${tx(t.table)} default values`
        return { outcome: 'allowed', rowCount: 1 }
      }),
    classifyInsertError,
  )
}

function anonUpdate(sql: Sql, t: TableInfo): Promise<Measurement> {
  const column = t.ownerColumn ?? t.columns.find((c) => c.writable && !c.name.includes('.'))?.name
  if (column === undefined) return Promise.resolve({ outcome: 'not_applicable', rowCount: null })
  return measure(() =>
    asCaller(sql, 'anon', undefined, async (tx) => {
      const result = await tx`update ${tx(t.schema)}.${tx(t.table)} set ${tx(column)} = ${tx(column)}`
      return allowedIfAny(result.count)
    }),
  )
}

function anonProbes(sql: Sql, t: TableInfo, actors: Actors, readOnly: boolean): PlannedProbe[] {
  const reads: PlannedProbe[] = [
    {
      actor: 'anon',
      action: 'select_all',
      run: () =>
        measure(() => asCaller(sql, 'anon', undefined, async (tx) => allowedIfAny(await countAll(tx, t)), readOnly)),
    },
  ]
  if (readOnly) return reads
  const owner = t.ownerColumn
  return [
    ...reads,
    { actor: 'anon', action: 'update_any', run: () => anonUpdate(sql, t) },
    {
      actor: 'anon',
      action: 'delete_any',
      run: () =>
        measure(() =>
          asCaller(sql, 'anon', undefined, async (tx) => {
            const result = await tx`delete from ${tx(t.schema)}.${tx(t.table)}`
            return allowedIfAny(result.count)
          }),
        ),
    },
    {
      actor: 'anon',
      action: 'insert_other',
      run: () =>
        owner === undefined
          ? insertDefaults(sql, t)
          : insertOwnedBy(sql, t, owner, actors.userB, 'anon', undefined),
    },
  ]
}

async function updateOthers(sql: Sql, t: TableInfo, owner: string, actors: Actors): Promise<Measurement> {
  const qualified = await measure(() =>
    asCaller(sql, 'authenticated', actors.userA, async (tx) => {
      const result = await tx`update ${tx(t.schema)}.${tx(t.table)} set ${tx(owner)} = ${tx(owner)} where ${tx(owner)} = ${actors.userB}`
      return allowedIfAny(result.count)
    }),
  )
  if (qualified.outcome !== 'denied') return qualified
  // Denied says little yet. Zero rows may mean the SELECT policy hid them, and 42501 may
  // mean WITH CHECK rejected B's row staying B's. Claiming the rows gets past both, and
  // is the real attack: `using (true) with check (owner = auth.uid())` hands over the table.
  return measure(() =>
    othersAffected(sql, t, owner, actors.userA, (tx) =>
      tx`update ${tx(t.schema)}.${tx(t.table)} set ${tx(owner)} = ${actors.userA}`.execute(),
    ),
  )
}

function ownedTableProbes(
  sql: Sql,
  t: TableInfo,
  owner: string,
  actors: Actors,
  readOnly: boolean,
): PlannedProbe[] {
  const { userA, userB } = actors
  const reads: PlannedProbe[] = [
    {
      actor: 'user_a',
      action: 'select_own',
      run: () =>
        measure(() =>
          asCaller(
            sql,
            'authenticated',
            userA,
            async (tx) => allowedIfAny(await countOwnedBy(tx, t, owner, userA)),
            readOnly,
          ),
        ),
    },
    {
      actor: 'user_a',
      action: 'select_others',
      run: () =>
        measure(() =>
          asCaller(
            sql,
            'authenticated',
            userA,
            async (tx) => allowedIfAny(await countNotOwnedBy(tx, t, owner, userA)),
            readOnly,
          ),
        ),
    },
  ]
  if (readOnly) return reads
  return [
    ...reads,
    { actor: 'user_a', action: 'update_other', run: () => updateOthers(sql, t, owner, actors) },
    {
      actor: 'user_a',
      action: 'delete_other',
      run: () =>
        measure(() =>
          othersAffected(sql, t, owner, userA, (tx) => tx`delete from ${tx(t.schema)}.${tx(t.table)}`.execute()),
        ),
    },
    {
      actor: 'user_a',
      action: 'insert_other',
      run: () => insertOwnedBy(sql, t, owner, userB, 'authenticated', userA),
    },
  ]
}

function userProbes(sql: Sql, t: TableInfo, actors: Actors, readOnly: boolean): PlannedProbe[] {
  if (t.ownerColumn !== undefined) return ownedTableProbes(sql, t, t.ownerColumn, actors, readOnly)
  return [
    {
      actor: 'user_a',
      action: 'select_all',
      run: () =>
        measure(() =>
          asCaller(sql, 'authenticated', actors.userA, async (tx) => allowedIfAny(await countAll(tx, t)), readOnly),
        ),
    },
  ]
}

/**
 * Every probe gets its own transaction, and so its own rollback, and they run one at a
 * time per table so that one probe's row locks can't trip the next one's lock timeout.
 */
export async function runTableProbes(
  sql: Sql,
  t: TableInfo,
  actors: Actors,
  settings: ProbeSettings,
): Promise<ProbeResult[]> {
  const plan = [
    ...(settings.anon ? anonProbes(sql, t, actors, settings.readOnly) : []),
    ...(settings.authenticated ? userProbes(sql, t, actors, settings.readOnly) : []),
  ]
  const results: ProbeResult[] = []
  for (const probe of plan) {
    const measurement = isProbeable(t) ? await probe.run() : INCONCLUSIVE
    results.push({ schema: t.schema, table: t.table, actor: probe.actor, action: probe.action, ...measurement })
  }
  return results
}

/** How many of other users' rows a caller can see, per owner. Counts and owner ids only. */
async function othersByOwner(
  sql: Sql,
  t: TableInfo,
  owner: string,
  role: ProbeRole,
  sub: string | undefined,
  userA: string,
  readOnly: boolean,
): Promise<ReadonlyMap<string, number> | undefined> {
  try {
    const rows = await asCaller(
      sql,
      role,
      sub,
      (tx) => tx<OwnerCount[]>`
        select coalesce(${tx(owner)}::text, '') as owner, count(*)::int as n
        from ${tx(t.schema)}.${tx(t.table)}
        where ${tx(owner)} is distinct from ${userA}
        group by 1`,
      readOnly,
    )
    return new Map(rows.map((row) => [row.owner, row.n]))
  } catch (error: unknown) {
    if (sqlStateOf(error) === undefined) throw error
    return undefined
  }
}

/**
 * True when, for every owner, the user sees no more of that owner's rows than anon does.
 * Comparing one total can't work: anon seeing 3 of C's public rows says nothing about the
 * user seeing 1 of B's private rows.
 */
export const coversEveryOwner = (
  seenByUser: ReadonlyMap<string, number>,
  seenByAnon: ReadonlyMap<string, number>,
): boolean => [...seenByUser].every(([owner, n]) => n <= (seenByAnon.get(owner) ?? 0))

/**
 * Whether a signed-in user sees nothing of other users' rows beyond what anon already can.
 * An unclear answer is `false`, which keeps the finding. The breakdown stays in here, so
 * these owner ids never reach the report.
 */
export async function seesNoMoreThanAnon(
  sql: Sql,
  t: TableInfo,
  actors: Actors,
  readOnly: boolean,
): Promise<boolean> {
  const owner = t.ownerColumn
  if (owner === undefined || !isProbeable(t)) return false
  const seenByUser = await othersByOwner(sql, t, owner, 'authenticated', actors.userA, actors.userA, readOnly)
  const seenByAnon = await othersByOwner(sql, t, owner, 'anon', undefined, actors.userA, readOnly)
  return seenByUser !== undefined && seenByAnon !== undefined && coversEveryOwner(seenByUser, seenByAnon)
}

/** Row total and top owners, as the connecting role. Counts and owner ids only. */
export async function gatherTableStats(sql: Sql, t: TableInfo, readOnly = false): Promise<TableStats> {
  if (!isProbeable(t)) return { total: null, owners: [] }
  const owner = t.ownerColumn
  try {
    return await inRolledBackTx(
      sql,
      async (tx) => ({
        total: await countAll(tx, t),
        owners:
          owner === undefined
            ? []
            : await tx<OwnerCount[]>`
              select ${tx(owner)}::text as owner, count(*)::int as n
              from ${tx(t.schema)}.${tx(t.table)}
              where ${tx(owner)} is not null
              group by 1 order by 2 desc limit 2`,
      }),
      { readOnly },
    )
  } catch (error: unknown) {
    if (sqlStateOf(error) === undefined) throw error
    return { total: null, owners: [] }
  }
}
