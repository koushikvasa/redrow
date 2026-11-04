import type { Sql } from 'postgres'
import { sqlStateOf } from './tx'
import type { Actors } from './types'

export interface OwnerCount {
  readonly owner: string
  readonly n: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface OwnerTally {
  readonly owner: string
  readonly tables: number
  readonly rows: number
}

function tallyOwners(perTable: readonly (readonly OwnerCount[])[]): OwnerTally[] {
  const uuidOwners = perTable.flat().filter(({ owner }) => UUID.test(owner))
  const owners = [...new Set(uuidOwners.map(({ owner }) => owner))]
  return owners.map((owner) => {
    const entries = uuidOwners.filter((entry) => entry.owner === owner)
    return { owner, tables: entries.length, rows: entries.reduce((sum, { n }) => sum + n, 0) }
  })
}

/**
 * User A is the owner found across the most tables, then with the most rows, so
 * their probes cover the most. User B is the next one. Either may be missing.
 * A pinned user is always user A, whatever they own.
 */
export function chooseActors(perTable: readonly (readonly OwnerCount[])[], pinnedUserA?: string): Partial<Actors> {
  const ranked = tallyOwners(perTable)
    .sort((a, b) => b.tables - a.tables || b.rows - a.rows)
    .map(({ owner }) => owner)
  const [first, second] = pinnedUserA === undefined ? ranked : [pinnedUserA, ...ranked.filter((owner) => owner !== pinnedUserA)]
  return {
    ...(first === undefined ? {} : { userA: first }),
    ...(second === undefined ? {} : { userB: second }),
  }
}

/** The id only. Undefined if there's no such user, or no auth schema this role can read. */
export async function findUserIdByEmail(sql: Sql, email: string): Promise<string | undefined> {
  try {
    const rows = await sql<{ id: string }[]>`select id::text as id from auth.users where lower(email) = lower(${email}) limit 1`
    return rows[0]?.id
  } catch (error: unknown) {
    if (sqlStateOf(error) === undefined) throw error
    return undefined
  }
}

async function randomUserId(sql: Sql): Promise<string> {
  const rows = await sql<{ id: string }[]>`select gen_random_uuid()::text as id`
  const id = rows[0]?.id
  if (id === undefined) throw new Error('gen_random_uuid() returned no row')
  return id
}

/** Fills in whoever the data didn't provide with a uuid that owns nothing. */
export async function resolveActors(sql: Sql, found: Partial<Actors>): Promise<Actors> {
  return {
    userA: found.userA ?? (await randomUserId(sql)),
    userB: found.userB ?? (await randomUserId(sql)),
  }
}
