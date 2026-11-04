# Engine spec — introspection, rules, probes, scoring

The engine is `packages/engine`. Public API:

```ts
export async function scan(sql: Sql, opts?: ScanOptions): Promise<ScanResult>
export function toReport(result: ScanResult): Report   // the public JSON contract, §5

interface ScanOptions {
  schemas?: readonly string[]        // default ['public']
  readOnly?: boolean                 // skip every write probe; reads run in a READ ONLY transaction
  ownerColumns?: Record<string /* table */, string /* column */>  // wins over detection
  tables?: readonly string[]         // limit the scan; views and functions are left out too
  actors?: { userA: string; userB: string }  // instead of picking them from the data
  roles?: { anon?: boolean; authenticated?: boolean }             // skip all probes for a role
  publicTables?: readonly string[]   // tables anon is meant to read, §4
  onPhase?: (phase: 'introspect' | 'actors' | 'probes') => void
}
```

Pipeline: **introspect → static rules → pick actors → dynamic probes → merge → declared exposure → score**. Catalog reads and row totals run as the connecting role (normally `postgres`). Probes run as `anon` / `authenticated`, each in its own rolled-back transaction.

---

## 1. Introspection (catalog only, no user data)

All queries bind schemas as `${schemas}::text[]`. postgres.js v4 removed `sql.array()`.

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
where c.relkind in ('r','p') and n.nspname = any(${schemas}::text[])
order by 1, 2;
```

### Columns (names + types only, for sensitivity + owner detection)
`writable` is false for generated and `generated always` identity columns, which can't be assigned to.
```sql
select c.oid as table_oid, a.attnum, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
       (a.attgenerated = '' and a.attidentity <> 'a') as writable
from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any(${schemas}::text[]) and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped
order by 1, 2;
```

### Policies
```sql
select schemaname as schema, tablename as table, policyname as name, permissive,
       roles::text[] as roles, cmd, qual, with_check
from pg_policies where schemaname = any(${schemas}::text[])
order by 1, 2, 3;
```

### Views (RLS bypass)
```sql
select n.nspname as schema, c.relname as view, c.relkind,
       exists (select 1 from unnest(coalesce(c.reloptions, '{}')) o
               where o in ('security_invoker=true','security_invoker=on','security_invoker=1')) as security_invoker,
       has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('v','m') and n.nspname = any(${schemas}::text[])
order by 1, 2;
```

### SECURITY DEFINER functions callable from the API
```sql
select n.nspname as schema, p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prosecdef and n.nspname = any(${schemas}::text[])
order by 1, 2, 3;
```

### Owner column detection (in priority order)
1. `ownerColumns` from `redrow.config.json`. A column that doesn't exist on the table is an error.
2. FK to `auth.users(id)`. A primary key that is itself such an FK wins (`profiles.id`), because the table is 1:1 with users. Among other FKs, the name list below breaks ties, then column order.
```sql
select con.conrelid as table_oid, a.attname as column,
       exists (select 1 from pg_constraint pk
               where pk.conrelid = con.conrelid and pk.contype = 'p'
                 and pk.conkey = array[a.attnum]) as is_sole_pk
from pg_constraint con
join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any(con.conkey)
where con.contype = 'f' and con.confrelid = 'auth.users'::regclass;
```
3. Name heuristic on `uuid` columns, in this order: `user_id, owner_id, created_by, author_id, profile_id, clinician_id, account_id`.

### Index check (leading columns, one query for all)
```sql
select i.indrelid as table_oid, i.indkey[0] as attnum
from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = any(${schemas}::text[]);
```

### Sensitive-column heuristic
Column name contains any of: `email, phone, dob, birth, ssn, address, diagnosis, note, medical, salary, token, secret, password, card, iban`. It decides whether RR003, RR101 and un-owned-table evidence apply. It doesn't change a rule's severity.

### Missing Supabase objects
SQLSTATE `42P01`, `3F000` or `42704` during introspection means `auth.users` or the API roles are absent. The scan fails with "This doesn't look like a Supabase database".

---

## 2. Static rules

Policies apply to the API only if their roles include `public`, `anon` or `authenticated`. `service_role` has BYPASSRLS, so its policies are ignored. RR003, RR004 and RR005 also need a permissive policy: a restrictive one can only narrow access.

| ID | Severity | Condition |
|---|---|---|
| RR001 | critical | Table in a scanned schema, **RLS disabled**, and `anon_select` (publicly readable via API) |
| RR002 | high | RLS disabled, no `anon_select`, and `anon` or `authenticated` holds any privilege |
| RR003 | high | SELECT/ALL policy with `qual` = `true` on a table with an owner column or sensitive columns |
| RR004 | medium | UPDATE/ALL policy with `qual` but **no `with_check`**. Postgres reuses USING as the check, so rows can only be re-owned if USING isn't owner-scoped; an explicit WITH CHECK states the rule either way |
| RR005 | medium | INSERT policy on an owned table with `with_check` = `true` (any owner can be written), or null (Postgres **denies every insert**, probably by mistake) |
| RR006 | high | View/matview selectable by anon/authenticated **without `security_invoker`** (bypasses RLS) |
| RR007 | high | SECURITY DEFINER function executable by `anon` (medium if only `authenticated`) |
| RR008 | low | Policy uses bare `auth.uid()` (not `( SELECT auth.uid() AS uid)`) — per-row re-evaluation, slow at scale |
| RR009 | low | Owner column used in a policy has no index leading with it |
| RR010 | medium | RLS enabled but **zero policies** and privileges granted (table silently returns nothing — likely a bug) |

Dynamic rules (from probes, section 3):

| ID | Severity | Condition |
|---|---|---|
| RR101 | critical | `anon` can SELECT ≥1 row of an owned or sensitive table |
| RR102 | critical | user A can SELECT rows owned by others (`rowsExposed` = count) |
| RR103 | critical | user A can UPDATE rows owned by others |
| RR104 | critical | user A can DELETE rows owned by others |
| RR105 | high | user A can INSERT a row owned by B |
| RR106 | high | `anon` can UPDATE/DELETE/INSERT on any table (one finding per action) |

Dedupe: if RR102 fires, suppress RR003 for the same table (dynamic proof wins; RR003's text is kept in RR102's detail as the cause, and its policy name is kept).

Every hint quotes identifiers, so it stays valid for names like `"User"`. Prose in a hint goes in a trailing SQL comment, so it can be pasted and run as is.

---

## 3. Dynamic probes

**Every probe runs in its own transaction, and so gets its own rollback.** Probes for one table run one after another, so one probe's row locks can't trip the next one's lock timeout. Up to 4 tables run at once. A name holding a dot can't be probed, because the driver's `sql(name)` turns `a.b` into `"a"."b"`: its probes are marked inconclusive and the report carries a warning.

### Rollback wrapper (`src/tx.ts`)
```ts
class RollbackSignal extends Error {}
async function inRolledBackTx<T>(sql: Sql, fn: (tx: TransactionSql) => Promise<T>, { readOnly = false } = {}): Promise<T> {
  const mode = `isolation level repeatable read${readOnly ? ' read only' : ''}`
  let out: T | undefined
  try {
    await sql.begin(mode, async tx => {
      await tx`set local statement_timeout = '5s'`
      await tx`set local lock_timeout = '1s'`
      out = await fn(tx)
      throw new RollbackSignal()
    })
  } catch (e) { if (!(e instanceof RollbackSignal)) throw e }
  return out as T
}
```
Repeatable read keeps before and after counts comparable: another session's commit can't shift them, while the transaction still sees its own writes.

### Picking actors (ids only)
For each table, as the connecting role, inside a rolled-back transaction: `select count(*)` for the total, and for owned tables:
```sql
select ${owner}::text as owner, count(*)::int as n from ${table} where ${owner} is not null
group by 1 order by 2 desc limit 2;
```
- `userA` = the owner found in the most tables, then with the most rows. Non-uuid values are ignored, because `auth.uid()` would fail on them.
- `userB` = the next owner if one exists, else `gen_random_uuid()`.
- `anon` = no sub.
- A count that hits the statement timeout leaves the total null rather than failing the scan.

### Impersonation (inside the transaction)
```ts
await tx.unsafe(`set local role ${role}`)              // role ∈ {'anon','authenticated'} only
await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role })}, true),
                set_config('request.jwt.claim.sub', ${sub ?? ''}, true),
                set_config('request.jwt.claim.role', ${role}, true)`
```
`set_config(..., true)` is the parameterized form of `SET LOCAL`. **A failed role switch raises `ImpersonationError` and fails the whole scan.** Read as a denied probe, it would make every table look safe.

A connecting role that isn't a superuser and doesn't have BYPASSRLS gets a warning, because its counts may be low and leaks can be missed.

### Why these probes write without a WHERE
A `WHERE` or `SET` that reads a column also applies the **SELECT policy**. So on a table with an owner-scoped read policy, `delete from T where owner = B` affects 0 rows even when the delete policy is wide open, and a plain `delete from T` removes B's rows. The real attack needs no WHERE, so the probes don't use one. They measure the effect by counting other users' rows as the connecting role, before and after, within the transaction:
```ts
before = count(*) where owner is distinct from A   // as the connecting role
impersonate(A); <mutation>; set local role none
after  = count(*) where owner is distinct from A   // sees this transaction's own writes
rowCount = before - after                          // > 0 means allowed; no other users' rows means not_applicable
```

### Probes per table
As **anon**:
- `select_all`: `select count(*) from T`
- not read-only:
  - `update_any`: `update T set C = C`, where C is the owner column or else the first writable column. No such column is `not_applicable`.
  - `delete_any`: `delete from T`
  - `insert_other`: `insert into T (owner) values (B)`, or `insert into T default values` on an un-owned table

As **userA**, on owned tables:
- `select_own`: `select count(*) from T where owner = A`
- `select_others`: `select count(*) from T where owner is distinct from A` (RR102 if > 0)
- not read-only:
  - `update_other`, in two steps. First `update T set owner = owner where owner = B`. If that is denied, for either reason (0 rows because the SELECT policy hid them, or `42501` because WITH CHECK rejected B's row staying B's), then the re-own `update T set owner = A`, measured by before and after counts. This catches `using (true) with check (owner = auth.uid())`, which lets anyone claim every row.
  - `delete_other`: `delete from T`, measured by before and after counts (RR104)
  - `insert_other`: `insert into T (owner) values (B)`, measured by counting B's rows before and after, because a BEFORE trigger may have rewritten the owner to the caller

As **userA**, on un-owned tables: `select_all`, `select count(*) from T`. If it equals the total, RLS is on and the table has sensitive columns, that is RR003 evidence ("every signed-in user sees all N rows").

### Outcomes
| Result | Outcome | `rowCount` |
|---|---|---|
| Count > 0 | `allowed` | the count |
| Count = 0 | `denied` | 0 |
| SQLSTATE `42501` | `denied` | null |
| Insert fails with `23502`, `23503`, `23505`, `23514` or `23P01` | `allowed` | null |
| No other users' rows to affect | `not_applicable` | 0 |
| No column can be assigned (`update_any`) | `not_applicable` | null |
| `55P03`, `40P01`, `40001` | retried once, then `inconclusive` | null |
| Any other SQLSTATE, such as `57014` (timeout) or a trigger raising | `inconclusive` | null |
| Connection, login, resource or shutdown error (SQLSTATE class `08`, `28`, `53`, `57P`), any error before the transaction is set up, or no SQLSTATE at all | the scan fails | |

**Only an error raised after the transaction is set up counts as a probe's answer.** Supabase's pooler can refuse a login with `28P01` or `42704`, and a code alone can't tell that from a policy's answer: read as a result, it would make a table look safe.

**Constraint errors on insert count as allowed because Postgres checks RLS WITH CHECK first.** A denied row gets `42501`, so `23502` means RLS let it through and only an incomplete test row was rejected. A complete row would succeed.

Read-only mode doesn't record the write probes at all.

Every probe is recorded as `ProbeResult { schema, table, actor, action, outcome: 'allowed'|'denied'|'inconclusive'|'not_applicable', rowCount }`.

### What a rollback can't undo
Row changes always roll back, but probes do fire triggers. So sequence values advance, and triggers calling extensions such as `dblink` or `http` can have outside effects. A trigger taking a session-level advisory lock keeps it after the rollback. Unfiltered updates and deletes add load for up to 5 seconds per statement. The CLI says so in its banner and in the production guard.

### Tests
`packages/engine/test/rollback.test.ts` runs when `REDROW_TEST_DB_URL` is set, and the test run says clearly when it is skipped. It inserts a sentinel row, then asserts from a fresh connection that the row is absent and `current_user` and the JWT claims are back to their defaults, including after a probe that throws.

---

## 4. Scoring

```
penalty = Σ weight(severity)   critical 25 · high 10 · medium 4 · low 1 · info 0
score   = max(0, 100 − penalty)
grade   = A ≥ 90 · B ≥ 75 · C ≥ 60 · D ≥ 40 · F < 40
```
Cap low-severity penalties at 10 total so perf hints never dominate. Any critical → grade can be at most D.

### Declared exposure (`publicTables`)
Tables the project means to expose, such as HQ's public board, are listed in `publicTables`. A bare name means the `public` schema, so it can't reach `private.users` by accident; use `schema.table` for anything else. A finding on such a table becomes **`info`**, "declared exposure": it stays in the report, scores nothing and never fails a scan. The CLI always says on stderr which file declared which tables.

**This covers anon reads and nothing else.** Only these findings qualify:

| Rule | Qualifies when |
|---|---|
| RR001, RR101 | always, subject to the check below |
| RR003 | the policy is `FOR SELECT` and applies to `anon` or `public`, and the finding came from the catalog rather than a signed-in user's probe |

And **no finding on the table qualifies if the catalog shows a way to write**. This reads no probe results, because write probes don't run under `--read-only` and can come back inconclusive:

| RLS | Write exposure means |
|---|---|
| off | `anon` or `authenticated` holds an INSERT, UPDATE or DELETE grant, which then works on every row |
| on | a permissive INSERT, UPDATE, DELETE or ALL policy applies to `anon` or `public`. Grants don't count here, because Supabase grants them by default and RLS decides |

**RR102 is dropped, not downgraded, when user A sees nothing beyond what anon can.** The check runs only when an RR102 on a declared table depends on it, once as A and once as anon, each in its own rolled-back transaction:
```sql
select coalesce(${owner}::text, '') as owner, count(*)::int as n from ${table}
where ${owner} is distinct from ${A} group by 1;
```
RR102 goes away only if, **for every owner**, A's count is at or below anon's. One total can't answer this: anon seeing 3 of C's public rows says nothing about A seeing 1 of B's private rows, and that real leak would otherwise score 100. If A sees more of any owner's rows, if either count is refused or times out, if anon is switched off, or if the write check above fails, RR102 still counts. The per-owner counts stay inside the engine, so these ids never reach the report.

**Known limit:** counts can't tell different rows of the *same* owner apart. If B has one public and one private row, and each role's policy shows it a different one, the counts match and RR102 is dropped. This needs anon and authenticated to have separate policies where the authenticated one hides public rows. Closing it would mean reading row addresses, which the "counts and owner ids only" rule doesn't allow. Row counts also say nothing about columns, so column-level grants that differ by role aren't compared.

Everything else keeps its severity, including every write finding.

## 5. Results

`ScanResult` is the engine's return value. **`Report`, from `toReport()`, is the public JSON contract**: what `redrow scan --json` prints, and what H5 ingests and H6 renders. Bump `version` for any breaking change.

```ts
interface Report {
  version: 1
  scannedAt: string
  database: { host: string; name: string; schemas: string[] }  // no credentials or user names, ever
  findings: ReportFinding[]                                    // most severe first, then rule id, then table
  summary: {
    total: number               // findings that count against the score; excludes info
    bySeverity: { critical: number; high: number; medium: number; low: number; info: number }
    score: number
    grade: 'A'|'B'|'C'|'D'|'F'
    tablesScanned: number
    probesRun: number
    durationMs: number
    probes: ProbeResult[]       // every probe, including denied ones: the leak matrix. Counts only
    inconclusive: number        // probes that proved nothing either way
    warnings: string[]          // reasons this report may understate the leaks
  }
}

interface ReportFinding {
  id: string                    // rule id, such as 'RR102'
  severity: 'critical'|'high'|'medium'|'low'|'info'
  table: string | null          // null for schema-level objects such as functions
  policy: string | null
  probe: string | null          // 'actor:action', such as 'user_a:select_others'; null for catalog findings
  description: string           // what a caller could actually do
  evidence:
    | { kind: 'probe'; schema: string; actor: string; action: string; outcome: string; rowCount: number | null }
    | { kind: 'catalog'; schema: string }
  remediation: string
}
```
Actor ids stay out of the report on purpose: they are real user ids, and the report may be shared.

```ts
interface ScanResult {
  engineVersion: string; startedAt: string; durationMs: number
  target: { host: string; database: string; schemas: string[] }  // never credentials
  score: number; grade: 'A'|'B'|'C'|'D'|'F'
  counts: { critical: number; high: number; medium: number; low: number; info: number }
  tables: { schema: string; table: string; rlsEnabled: boolean; ownerColumn?: string; totalRows: number | null; sensitive: string[] }[]
  findings: Finding[]
  probes: ProbeResult[]
  actors: { userA: string; userB: string } // uuids only
  warnings: string[]
}
```

### CLI behaviour
- Exit codes: `0` no findings at or above `--severity` (default `low`), `1` findings, `2` could not run, or every probe was inconclusive. `info` never fails a scan and isn't a `--severity` level.
- `--json` writes only JSON to stdout. The banner and warnings go to stderr.
- Production guard: refuses a host that isn't local when the database name doesn't contain `test`, `demo` or `staging`, unless `-y` (`--i-know-what-im-doing`) is passed or the target **exactly** matches an entry in `allowHosts` in `redrow.config.json`. An entry is a host, or `host/login`. Wildcards are rejected. Supabase databases are always named `postgres`, so a Supabase scan needs one of the two. **Every project in a region shares its pooler host and differs only by login**, so use `host/login` there: a bare pooler host waives the guard for all of them, and any bare entry prints a warning on stderr.
- The driver gets explicit connection fields, never the url, so the guard judges what actually gets connected to. Query parameters other than `sslmode` and `pgbouncer` are refused, because the driver lets them override the host and database. Remote connections use TLS: `sslmode=disable` is refused, and `prefer` and `allow` become `require`.

## 6. Fix generation (`redrow fix`)

`redrow fix --from report.json [--db url] [--apply] [--out file.sql] [--config path] [-y]`

Input: `report.json` + catalog text for affected tables (columns, existing policies). Never row data. The report's host and database must match the connection, and the production guard applies as it does for `scan`.

The migration: enables RLS where missing, replaces leaky policies with owner-scoped ones using `(select auth.uid())`, adds `with check`, sets `security_invoker = true` on views, revokes `execute` on risky SECURITY DEFINER functions from `anon, authenticated, public`, because they skip RLS and a signed-in user who could still call one would bypass the new policies, adds missing indexes. Wrapped in `begin; … commit;`, each block commented with the rule ID it fixes. Written to `redrow-fix-<timestamp>.sql`, or `--out`. Only applied with `--apply`, which then rescans and prints before → after.

Two sources, same checks:
- **Claude**, when `ANTHROPIC_API_KEY` is set. Model from `REDROW_MODEL`, default `claude-sonnet-5-5`. Requests allow the API's server-side fallback, in case a safety classifier declines a prompt about attacking access control. A rejected migration gets one retry that says why. An API failure gets none. Either way it falls back to templates, with a warning.
- **Rule-based templates**, otherwise. They're built only from rule ids and the database's catalog, so nothing in the report file becomes SQL. Findings no template can safely fix, such as an open read on a table with no owner column, are listed on stderr. A `publicTables` table keeps its read policies.

The SQL can come from a model, and names in the prompt can be written by anyone who can create a table, so it's treated as hostile:
1. **Parse.** `src/fix/migration.ts` splits it the way Postgres would (strings, dollar quotes, nested comments, a comment ending at `\r`) and checks every statement against an allowlist: enable or force RLS, create, alter or drop policy, `security_invoker = true`, non-unique indexes on plain columns, and revoke. No `cascade`, no `begin`, `commit`, `set`, DML or `grant` in the body, new policies must say `to authenticated`, and no expression may be literally `true`. Index expressions are out because they run per row during validation, where they could call a function or put a row's value in an error, and that error goes back to the model on a retry.
2. **Scope (model SQL only).** `src/fix/scope.ts`: every statement must name a schema-qualified object the report found a problem with, and may not alter or drop a restrictive policy. Templates can't need this, since they only name what's in the catalog.
3. **Validate.** Each statement runs inside a transaction that is always rolled back. It takes real locks while it runs, and the 5s statement timeout applies, so a very large table can fail validation on its index.
4. **Execute one at a time.** Statements are sent over the extended protocol, where the server refuses more than one command per message. `begin` and `commit` from the text are never sent; the driver's transaction does that. If the parser were ever fooled, a `commit` still couldn't end the rolled-back validation.

The file is written from the parsed statements, not the input, so it can't hold SQL that wasn't checked.

**What this doesn't stop:** these checks judge a statement's kind and target, not whether its logic is right. A model could write `using (1 = 1)` on a reported table. It would validate, and `--apply` would commit it. The rescan then reports it and the command exits 1, but that's after the commit. So read the file before `--apply` when it came from a model. Rescanning before the commit would mean running probes inside one transaction, which the engine doesn't support.

### HTML report (`redrow scan --html <file>`)

One self-contained file: inline CSS and JS, and a `default-src 'none'` CSP so the browser enforces "no external requests". Every string is HTML-escaped and stripped of control characters, because names come from the scanned database. The matrix's columns are anon (read, insert, update, delete), user A's own rows (read), and user A against other users' rows (read, insert, update, delete). The probes use one signed-in attacker, so user B appears as the owner of the rows being attacked, not as a separate column group.
