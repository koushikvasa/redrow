# Engine spec — introspection, rules, probes, scoring

The engine is `packages/engine`. Public API:

```ts
export async function scan(sql: Sql, opts: ScanOptions): Promise<ScanResult>
// ScanOptions: { schemas: string[] (default ['public']), readOnly: boolean,
//               ownerColumns?: Record<string /* table */, string /* column */> }
```

Pipeline: **introspect → static rules → pick actors → dynamic probes → score**. All catalog reads run as the connecting role (normally `postgres`). All probes run inside a rolled-back transaction.

---

## 1. Introspection (catalog only, no user data)

### Tables + grants
```sql
select n.nspname as schema, c.relname as table, c.oid,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       has_table_privilege('anon', c.oid, 'SELECT')          as anon_select,
       has_table_privilege('anon', c.oid, 'INSERT')          as anon_insert,
       has_table_privilege('anon', c.oid, 'UPDATE')          as anon_update,
       has_table_privilege('anon', c.oid, 'DELETE')          as anon_delete,
       has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
       has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
       has_table_privilege('authenticated', c.oid, 'DELETE') as auth_delete
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p') and n.nspname = any(${schemas});
```

### Columns (names + types only, for sensitivity + owner detection)
```sql
select c.oid as table_oid, a.attnum, a.attname as column, format_type(a.atttypid, a.atttypmod) as type
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any(${schemas}) and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped;
```

### Policies
```sql
select schemaname as schema, tablename as table, policyname as name, permissive,
       roles, cmd, qual, with_check
from pg_policies where schemaname = any(${schemas});
```

### Views (RLS bypass)
```sql
select n.nspname as schema, c.relname as view, c.relkind,
       exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
               where o in ('security_invoker=true','security_invoker=on','security_invoker=1')) as security_invoker,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v','m') and n.nspname = any(${schemas});
```

### SECURITY DEFINER functions callable from the API
```sql
select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname = any(${schemas});
```

### Owner column detection (in priority order)
1. `ownerColumns` from `redrow.config.json`.
2. FK to `auth.users(id)`:
```sql
select con.conrelid as table_oid, a.attname as column
from pg_constraint con
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
where con.contype = 'f' and con.confrelid = 'auth.users'::regclass;
```
3. Name heuristic on `uuid` columns: `user_id, owner_id, created_by, author_id, profile_id, clinician_id, account_id`.
4. Table whose **primary key** is an FK to `auth.users` (e.g. `profiles.id`) → owner column = pk.

### Index check for a column
```sql
select exists (select 1 from pg_index i where i.indrelid = ${oid} and i.indkey[0] = ${attnum});
```

### Sensitive-column heuristic (bumps severity)
Column name contains any of: `email, phone, dob, birth, ssn, address, diagnosis, note, medical, salary, token, secret, password, card, iban`.

---

## 2. Static rules

| ID | Severity | Condition |
|---|---|---|
| RR001 | critical | Table in exposed schema, **RLS disabled**, and `anon_select` (publicly readable via API) |
| RR002 | high | RLS disabled, only `authenticated` has privileges |
| RR003 | high | Policy for SELECT/ALL with `qual` = `true` on a table with an owner column or sensitive columns |
| RR004 | medium | UPDATE/ALL policy with `qual` but **no `with_check`** (rows can be re-owned) |
| RR005 | medium | INSERT policy with `with_check` null or `true` on owned table |
| RR006 | high | View/matview selectable by anon/authenticated **without `security_invoker`** (bypasses RLS) |
| RR007 | high | SECURITY DEFINER function executable by `anon` (medium if only `authenticated`) |
| RR008 | low | Policy uses bare `auth.uid()` (not `( SELECT auth.uid() AS uid)`) — per-row re-evaluation, slow at scale |
| RR009 | low | Owner column used in a policy has no index |
| RR010 | medium | RLS enabled but **zero policies** and privileges granted (table silently returns nothing — likely a bug) — informational-ish |

Dynamic rules (from probes, section 3):

| ID | Severity | Condition |
|---|---|---|
| RR101 | critical | `anon` can SELECT ≥1 row of an owned or sensitive table |
| RR102 | critical | user A can SELECT rows owned by user B (`rowsExposed` = count) |
| RR103 | critical | user A can UPDATE rows owned by B |
| RR104 | critical | user A can DELETE rows owned by B |
| RR105 | high | user A can INSERT a row owned by B |
| RR106 | high | `anon` can UPDATE/DELETE/INSERT on any table |

Dedupe: if RR102 fires, suppress RR003 for the same table (dynamic proof wins; keep RR003 text as the explanation).

---

## 3. Dynamic probes

### Picking actors (ids only)
For each owned table, as the connecting role:
```sql
select ${owner} as owner, count(*)::int as n from ${table} where ${owner} is not null
group by 1 order by 2 desc limit 2;
```
- `userA` = most frequent owner across owned tables (prefer one that appears in several tables).
- `userB` = a different real owner if one exists, else `gen_random_uuid()`.
- `anon` = no sub.
Also record `total` row count per table (`select count(*)`), as the connecting role.

### Impersonation (inside the transaction)
```ts
await tx.unsafe(`set local role ${role}`)              // role ∈ {'anon','authenticated'} only
await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role })}, true)`
await tx`select set_config('request.jwt.claim.sub', ${sub ?? ''}, true)`
await tx`select set_config('request.jwt.claim.role', ${role}, true)`
```
Then `reset role` between actors (or use one transaction per actor — simpler, preferred).

### Probes per table (each in its own savepoint)
As **anon**:
- `select count(*) from T` → `anonVisible`
- if not readOnly: `update T set ${owner} = ${owner}` (or first column = itself if no owner) → affected count; `delete from T` → affected count

As **userA** (owned tables):
- `select count(*) from T where ${owner} = ${A}` → `ownVisible`
- `select count(*) from T where ${owner} is distinct from ${A}` → `othersVisible` (RR102 if > 0)
- not readOnly:
  - `update T set ${owner} = ${owner} where ${owner} = ${B}` → affected (RR103)
  - `delete from T where ${owner} = ${B}` → affected (RR104)
  - `insert into T (${owner}) values (${B})` → success = RR105; SQLSTATE `42501` = denied; other errors (`23502` not-null, `23503` FK, …) = `inconclusive`
    - v2 (stretch): copy one of A's rows into a temp structure, swap owner to B, drop PK/generated/unique columns, retry.

As **userA** (un-owned tables with RLS enabled): `select count(*)` → if equals `total` and table has sensitive columns → RR003 evidence ("every signed-in user sees all N rows").

Record every probe as `ProbeResult { table, actor, action, outcome: 'allowed'|'denied'|'inconclusive'|'not_applicable', rowCount }`.

### Rollback wrapper
```ts
class RollbackSignal extends Error {}
async function inRolledBackTx<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  let out!: T
  try {
    await sql.begin(async tx => {
      await tx`set local statement_timeout = '5s'`
      await tx`set local lock_timeout = '1s'`
      out = await fn(tx)
      throw new RollbackSignal()
    })
  } catch (e) { if (!(e instanceof RollbackSignal)) throw e }
  return out
}
```
Test: run a probe that inserts, then assert the row count is unchanged afterwards.

---

## 4. Scoring

```
penalty = Σ weight(severity)   critical 25 · high 10 · medium 4 · low 1
score   = max(0, 100 − penalty)
grade   = A ≥ 90 · B ≥ 75 · C ≥ 60 · D ≥ 40 · F < 40
```
Cap low-severity penalties at 10 total so perf hints never dominate. Any critical → grade can be at most D.

## 5. ScanResult (JSON report shape — also what `--upload` sends)

```ts
interface ScanResult {
  engineVersion: string; startedAt: string; durationMs: number
  target: { host: string /* masked */, schemas: string[] }
  score: number; grade: 'A'|'B'|'C'|'D'|'F'
  counts: { critical: number; high: number; medium: number; low: number }
  tables: { schema: string; table: string; rlsEnabled: boolean; ownerColumn?: string; totalRows: number; sensitive: string[] }[]
  findings: Finding[]
  probes: ProbeResult[]
  actors: { userA: string; userB: string } // uuids only
}
```

## 6. Fix generation (`redrow fix`)

Input: `report.json` + catalog text for affected tables (columns, existing policies). Never row data.
Prompt Claude to return **one SQL migration** that: enables RLS where missing, replaces leaky policies with owner-scoped ones using `(select auth.uid())`, adds `with check`, sets `security_invoker = true` on views, revokes `execute` on risky SECURITY DEFINER functions from `anon`, adds missing indexes. Wrap in `begin; … commit;`, comment each block with the rule ID it fixes. Write to `redrow-fix-<timestamp>.sql`. Only apply with `--apply` (then rescan automatically).
