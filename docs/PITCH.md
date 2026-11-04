# Pitch, research backing, demo script

## One-liner
**AI wrote your RLS. Red Row proves whether it leaks.** `npx redrow scan` attacks your Supabase Row Level Security as anon / user A / user B inside rolled-back transactions and shows exactly who can read and write what.

## The problem (what the judges already know)
- **CVE-2025-48757 (CVSS 9.3):** insufficient RLS policies in Supabase databases behind Lovable-generated sites let unauthenticated attackers read arbitrary user data.
- **Moltbook (Jan 2026):** a "didn't write a single line of code" app exposed 4.75M records incl. 1.5M API tokens through missing database access controls (Cloud Security Alliance research note, Apr 2026).
- **Large-scale study of vibe-coded apps (arXiv 2606.23130):** broken access control is the #1 vulnerability category, present in **64% of apps**.
- **LLM-generated access policies (arXiv 2609.24036, Sep 2026):** single-shot generation produced semantically wrong deny rules **62.5%** of the time and dropped ownership conditions **60%** of the time. The policies are syntactically valid — linters pass them.

## Why existing tools don't catch it
Supabase Security Advisor is a static linter: it tells you RLS is **on**. A policy like `using (true)` for `authenticated` is "on", passes the linter, and still lets every signed-in user read every patient. Only an actual attack proves it. **Advisor checks configuration. Red Row checks behavior.**

## How it works (30-second version)
1. Introspect catalog: tables, grants, policies, views, SECURITY DEFINER functions.
2. Pick real owner ids from the data (ids only, never row contents).
3. In a transaction: `set local role authenticated`, set `request.jwt.claims` to user A, try to read/insert/update/delete user B's rows. Count what succeeds. **Rollback.** Nothing ever persists.
4. Score 0–100, leak matrix, and `redrow fix` asks Claude for a migration (schema + policy text only — never data).

## Judging map (25% each)
| Criterion | What we show |
|---|---|
| Data quality | HQ is insert-only, constrained, written every minute by a pg_cron sweep → Sodabase score |
| Built to scale | HQ schema: every FK + policy column indexed, `(select auth.uid())`, forced RLS, service-role-only writes. **Red Row scans HQ → 100.** |
| Execution | Live: scan CareNote → red → fix → rescan green, end to end, on stage |
| Craft | One-line install, open source (MIT), beautiful HTML report + live dashboard |

## 3-minute demo script
1. **(0:00) Hook.** "Raise your hand if an AI has written an RLS policy for you. This is CareNote — a clinic app the way an AI builder generates it. Supabase Advisor is mostly happy with it."
2. **(0:25) Attack.** Run `npx redrow scan --db $CARENOTE`. Terminal turns red: score 0/F. "Logged in as Dr. Ana, I can read **all 120 patients**, and delete Dr. Ben's notes. Anonymous visitors can read every clinician's email."
3. **(1:05) Matrix.** Dashboard: leak matrix (anon / Dr. Ana / Dr. Ben × tables × read/insert/update/delete). Red cells with row counts. Invoices row is green — "the one table the AI got right."
4. **(1:35) Fix.** `npx redrow fix --apply`. Show the generated migration, every block labeled with the rule it fixes. Rescan → 100/A. Dial animates.
5. **(2:10) Safety.** "Every attack runs inside a transaction that's rolled back. We record counts and ids, never row contents. Safe to run on prod."
6. **(2:30) Scale + data quality.** "And our own backend? Red Row scans it every minute: 100. Here's our Sodabase score." Show both.
7. **(2:50) Close.** "`npx redrow scan`. Open source today. Run it on your project before someone else does."

## Likely judge questions
- **"Isn't this Security Advisor?"** Advisor = static config lint. We prove exploitability with real counts, catch semantic leaks (`using (true)`, missing ownership, missing `with check`) that lint clean, and generate the fix.
- **"Is it safe on production?"** Every probe is inside `begin … rollback`, with 5s statement timeout and 1s lock timeout. `--read-only` skips writes entirely. We never select row contents.
- **"What about complex policies (joins, teams)?"** Probes are behavioral, so they work regardless of policy complexity; ownership detection uses FKs to `auth.users` with config override for team-based schemas.
- **"Why the Sodabase angle?"** Scan history is data we want to trust: insert-only, constrained, continuously fresh.
