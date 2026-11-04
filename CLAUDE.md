# Red Row — project brief for Claude Code

> **AI wrote your RLS. Red Row proves whether it leaks.**

Red Row is an open-source CLI (clone the repo, then `npm run scan`) that **attacks a Supabase project's Row Level Security** with simulated users and reports, with real row counts, who can read or write what. Every attack runs inside a transaction that is always rolled back. Sequence values and outside effects from triggers are the documented exceptions, so point it at a staging project or a branch where you can.

Built for the **Supabase × Sodabase × BuilderBase NYC Hackathon (Wed Nov 4, 2026)**. Read `docs/` before building anything:

- `docs/ENGINE.md` — exact introspection SQL, attack algorithm, rule IDs, scoring. **Source of truth for the engine.**
- `docs/SCHEMAS.md` — HQ (dashboard) schema + the deliberately leaky demo target ("CareNote").
- `docs/PITCH.md` — the problem, research backing, judging criteria, demo script.
- `docs/DEMO.md` — the 3-minute demo, step by step.
- `docs/history/HANDOVER.md` — build log, superseded by README.

---

## Why this exists (one paragraph)

AI app builders generate Supabase schemas and RLS policies that compile, pass linting, and still leak. Supabase's Security Advisor checks *whether RLS is on*; Red Row checks *whether it works* — by actually signing in as anon / user A / user B and trying to read and modify other users' rows. Output: a 0–100 score, a leak matrix, and (optionally) a Claude-written migration that closes each leak.

## Hackathon judging (25% each) — every decision should serve these

1. **Data quality** — Sodabase scores our HQ tables (freshness + row count). HQ tables are insert-only with `created_at`, written continuously by a `pg_cron` sweep. Never update/delete rows in HQ.
2. **Built to scale** — judges read our schema, indexes, RLS and edge functions. HQ must score **100 when Red Row scans itself.**
3. **Execution** — the live demo works end to end: scan → leaks → fix → rescan = 100.
4. **Craft** — polished, original, clear problem. Clone and run, beautiful report, great README.

Event constraints: building 4:30–7:00 PM, **Sodabase must be connected by 5:30 PM**, submit public repo + live URL/video + Sodabase score by 7:00 PM.

---

## Architecture

```
redrow/
├─ CLAUDE.md, README.md, LICENSE (MIT), .env.example
├─ docs/                      specs (read-only reference)
├─ packages/
│  ├─ engine/                 pure TypeScript: introspect → static rules → probes → score
│  │                          NO Node-only APIs, NO driver import: the caller injects a
│  │                          `postgres` (porsager) `sql` client. Runs in Node AND Deno.
│  └─ cli/                    `redrow` bin: commander, terminal output, JSON/HTML report, fix
├─ apps/web/                  Next.js (App Router) dashboard on Vercel, Supabase Realtime
├─ hq/supabase/               HQ project: migrations, seed, edge functions (ingest, sweep)
│  └─ functions/_shared/engine  ← copied build of packages/engine (`npm run sync:engine`)
└─ demo-target/supabase/      CareNote: deliberately leaky schema, seed script, reset/fixed SQL
```

Two separate Supabase cloud projects (free tier allows 2):
- **HQ** (`redrow-hq`): stores scans. Clean, indexed, perfect RLS. **This is the one connected to Sodabase.**
- **Demo target** (`carenote-demo`): intentionally vulnerable app we attack on stage.

## Tech stack (do not swap without a reason)

- Node 20+, TypeScript strict, **npm workspaces** (developer is on Windows — no bash-only scripts; use cross-platform Node scripts).
- DB driver: **`postgres`** (porsager) — works in Node and Deno (`npm:postgres` in edge functions).
- CLI: `commander`, `picocolors`, `cli-table3`, `ora`. Build with `tsup` → single ESM bin.
- Tests: `vitest`.
- AI: `@anthropic-ai/sdk`, model from env `REDROW_MODEL` (default `claude-sonnet-5-5`). AI is optional — **scan must work with zero API keys.**
- Web: Next.js + Tailwind + `@supabase/ssr`; deploy on Vercel.
- Supabase CLI via `npx supabase` (no global install).

## Non-negotiable safety rules (the product's credibility depends on these)

1. **Every probe runs inside `sql.begin()` and always ends in ROLLBACK.** Implement by throwing a private `RollbackSignal` at the end of the transaction callback and catching it. Each probe gets its own transaction, so one error can't affect the rest. Write a test that proves nothing persists.
2. **Never read or print row contents.** The engine may only read: counts, owner-column ids (uuids), catalog metadata. No `select *` on user tables anywhere.
3. Per transaction: `set local statement_timeout = '5s'`, `set local lock_timeout = '1s'`.
4. Identifiers are always escaped via the driver's identifier helper (`sql(name)`), never string-concatenated. Role names come from a fixed whitelist (`anon`, `authenticated`).
5. Only schema text, policy text and finding metadata may be sent to Claude — **never row data**.
6. `--read-only` flag skips all write probes. Print a banner at scan start: "All write probes run inside transactions that are rolled back."
7. Secrets only from env / `.env` (gitignored). Never log connection strings (mask the password).

## Coding conventions

- Small pure functions; the engine returns plain data (`ScanResult`), renderers are separate.
- Rule IDs `RR001`… defined once in `packages/engine/src/rules.ts` (see ENGINE.md).
- Every finding has: `ruleId, severity, schema, table?, title, detail, rowsExposed?, fixHint`.
- Exit codes: `0` no findings at or above `--severity` (default `low`), `1` findings, `2` usage/connection error, or every probe inconclusive.
- Prefer clear error messages for the common Supabase gotchas (see below).

## Supabase gotchas to handle

- Direct DB host is IPv6-only → tell users to use the **Session pooler** connection string (port 5432) if connection fails.
- `auth.uid()` reads `request.jwt.claims` (new) or `request.jwt.claim.sub` (old) — set **both** when impersonating.
- `pg_policies.qual` normalizes `(select auth.uid())` into `( SELECT auth.uid() AS uid)` — match that form.
- Supabase grants `anon`/`authenticated` privileges on new public tables by default, so "RLS disabled" = publicly readable via the API.
- Views ignore RLS unless `security_invoker = true`; materialized views never respect RLS.

## Definition of done (hackathon)

- `npm run scan -- --db $DEMO_DB_URL` prints a red report in < 10 s (the demo host is in `allowHosts`, or pass `-y`); `--html` writes a self-contained report.
- `npm run fix -- --from report.json` writes a migration; after applying it, rescan = 100 (or near).
- HQ scanning itself = 100. pg_cron sweep writes a scan about every minute. Sodabase connected.
- Dashboard live on Vercel: score dial, leak matrix, score-over-time, findings with copyable fix SQL.
- README with screenshots, clone-and-run quickstart, safety explanation, MIT license. Repo public.
