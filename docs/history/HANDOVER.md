> Build log, superseded by README.

# Handovers — paste ONE at a time into Claude Code

Each handover is small and ends in something runnable. Do not start the next one until the current one's "Done when" is true. Commit after each.

---

## H1 — Repo scaffold + engine core (tonight)

```
Read CLAUDE.md and docs/ENGINE.md fully before writing code.

Task H1: scaffold the monorepo and build the engine's introspection + static rules.

1. Create the npm workspaces monorepo exactly as in CLAUDE.md "Architecture": root package.json (workspaces: packages/*, apps/*), tsconfig.base.json (strict, ES2022, moduleResolution bundler), .gitignore (node_modules, dist, .env, *.local, redrow-report*.json, redrow-fix-*.sql), LICENSE (MIT, Koushik Vasa, 2026), .env.example (copy from root if present), git init.
2. packages/engine: TypeScript, no Node-only APIs, no driver import (accept an injected `postgres` Sql type via `import type`). Implement:
   - src/types.ts — ScanResult, Finding, ProbeResult, TableInfo etc. per ENGINE.md §5
   - src/rules.ts — rule catalog RR001–RR010 and RR101–RR106 (id, severity, title, fixHint template)
   - src/introspect.ts — every catalog query in ENGINE.md §1, owner-column detection (config → FK to auth.users → name heuristic → pk-is-fk), sensitive-column heuristic
   - src/static.ts — static rules RR001–RR010 as pure functions over the introspection result
   - src/score.ts — scoring per ENGINE.md §4
   - src/index.ts — export scan() that for now runs introspect + static + score (probes come in H2)
3. vitest unit tests for static rules and scoring using hand-built fixture objects (no DB needed).
4. npm run build / test scripts at root.

Done when: `npm test` passes and `npm run build` produces packages/engine/dist.
Do not build the CLI or probes yet.
```

---

## H2 — Probe engine + CLI (tonight)

```
Read CLAUDE.md (especially the safety rules) and docs/ENGINE.md §3.

Task H2: dynamic probes + the `redrow` CLI.

1. packages/engine/src/probes.ts:
   - inRolledBackTx() exactly as in ENGINE.md (RollbackSignal), set local statement_timeout 5s / lock_timeout 1s
   - actor selection (ids only), per-table probes for anon / userA, each in a savepoint, SQLSTATE 42501 → denied
   - impersonation sets role from whitelist + request.jwt.claims AND request.jwt.claim.sub/.role
   - dynamic rules RR101–RR106 and the RR102-suppresses-RR003 dedupe
   - readOnly option skips every write probe
   - wire into scan()
2. packages/cli (bin name `redrow`), commander + picocolors + cli-table3 + ora, built with tsup to one ESM file with a shebang:
   - `redrow scan --db <url> [--schema public] [--read-only] [--json out.json] [--html out.html] [--fail-under N] [--upload]`
     DB url also from REDROW_DB_URL / .env. Mask password in all output.
     Print the safety banner, a spinner per phase, then: big score + grade, findings table sorted by severity, leak matrix (tables × actor/action with ✔/✖ and counts), and "Fix it: npm run fix -- --from <json>".
   - Friendly error for connection failures suggesting the Session pooler string (port 5432).
   - Exit codes per CLAUDE.md.
3. A test `packages/engine/test/rollback.test.ts` that runs against REDROW_TEST_DB_URL if set (skip otherwise): count rows, run probes, assert counts unchanged.
4. Root script `npm run scan -- --db ...` for local use.

Done when: against a Supabase project with the CareNote leaky schema loaded (see H3), `npm run scan` prints a red report in under 10 seconds, and rerunning shows identical row counts (nothing persisted).
```

---

## H3 — CareNote demo target (tonight)

```
Read docs/SCHEMAS.md section B.

Task H3: build demo-target/.
1. demo-target/supabase/leaky.sql, reset.sql, fixed.sql exactly per SCHEMAS.md (fixed.sql is the reference answer).
2. demo-target/scripts/seed.mjs (Node, cross-platform): reads DEMO_SUPABASE_URL + DEMO_SERVICE_ROLE_KEY from .env, deletes old @carenote.test users, creates dr.ana / dr.ben / dr.cho via auth.admin.createUser, inserts fake patients/notes/appointments/invoices (fake names only).
3. demo-target/scripts/apply.mjs <file.sql>: runs a SQL file against DEMO_DB_URL with the postgres driver (so Windows users don't need psql).
4. Root scripts: `npm run demo:reset` (reset.sql → seed), `npm run demo:fix-reference` (fixed.sql).

Done when: demo:reset then `npm run scan -- --db $DEMO_DB_URL` scores ≤ 30 with RR001, RR003/RR102, RR004/RR103, RR104, RR105, RR006, RR007 present and invoices clean; demo:fix-reference then rescan = 100/A.
```

---

## H4 — Reports + `redrow fix` (tonight if time, else event)

```
Task H4:
1. packages/cli/src/report/html.ts: one self-contained HTML file (inline CSS/JS, no external requests). Dark, sharp, security-tool aesthetic: big score dial with grade, severity counts, leak matrix heatmap (red = allowed cross-user access with row count, green = denied, grey = n/a), findings list with fix hints, safety footer. Must look great in a screenshot.
2. `redrow fix --from report.json [--db url] [--apply] [--out file.sql]`:
   - Builds the prompt from findings + catalog text (columns, policies) for affected tables ONLY. Never row data.
   - Calls Anthropic (@anthropic-ai/sdk, model REDROW_MODEL default claude-sonnet-5-5, key ANTHROPIC_API_KEY). Without a key, print a clear message and fall back to rule-based templates for RR001/RR003/RR004/RR005/RR006/RR007/RR008/RR009.
   - Writes redrow-fix-<timestamp>.sql wrapped in begin/commit, each block commented with its rule ID. For RR007 it must revoke execute from anon, authenticated, public, as demo-target/supabase/fixed.sql does.
   - --apply runs it in a transaction, then automatically rescans and prints before → after score.

Done when: on CareNote, `redrow fix --from report.json --apply` brings the score to ≥ 95.
```

---

## H5 — HQ backend (event, BEFORE 5:30 PM — Sodabase checkpoint)

```
Read docs/SCHEMAS.md section A. Speed matters: Sodabase must be connected by 5:30.

Task H5:
1. hq/supabase/migrations/0001_init.sql exactly per SCHEMAS.md, 0002_cron.sql.
2. hq/scripts/seed-history.mjs: 14 days of backdated scans (every 15 min) for the two public projects, inserts only, realistic drift.
3. npm run sync:engine: cross-platform Node script that copies packages/engine/dist into hq/supabase/functions/_shared/engine.
4. Edge functions:
   - ingest: validates ScanResult, header x-redrow-key, inserts scan_runs + findings + probe_results in one transaction (postgres via npm:postgres and SUPABASE_DB_URL).
   - sweep: runs the engine against DEMO_DB_URL and against HQ itself (SUPABASE_DB_URL) and inserts both results.
5. CLI --upload posts to REDROW_INGEST_URL with REDROW_INGEST_KEY.
6. Deploy commands documented in README (npx supabase link / db push / functions deploy / secrets set).

Done when: cron writes a new scan_runs row for each project every minute, and `redrow scan` against HQ itself = 100.
```

---

## H6 — Dashboard (event, after 5:30)

```
Load the frontend-design skill if available. Task H6: apps/web Next.js App Router + Tailwind + @supabase/ssr, deploy to Vercel.
- Public board (no login): project cards for every is_public project with live score dial.
- Project page: score dial (animated), score-over-time line chart (last 24h + 14d), live leak matrix from the latest scan's probe_results, findings list grouped by severity with copy-to-clipboard fix hints, "last scanned Xs ago" ticker. Realtime subscription on scan_runs/findings so it updates every minute on screen.
- Hero: "AI wrote your RLS. Red Row proves whether it leaks." + copyable `npm run scan -- --db "..."` line and a link to the repo.
- Aesthetic: dark, precise, red-team. Red only for leaks; everything else restrained.

Done when: deployed URL updates live as the sweep runs.
```

---

## H7 — README + polish (last 20 minutes)

```
Write README.md: tagline, GIF/screenshot placeholder, 30-second quickstart (git clone, npm install, npm run scan -- --db "<session pooler url>"), what it checks (rule table), safety section (rollback, counts only, read-only mode), how fix works, CI usage, architecture diagram (text), research links from docs/PITCH.md, MIT license. Make it scannable.
```
