# Pitch, research backing, demo script

## One-liner
**AI wrote your RLS. Red Row proves whether it leaks.** `npm run scan` attacks your Supabase Row Level Security as a stranger and as real users, inside rolled-back transactions, and shows exactly who can read and write what.

## The story
1. **RLS leaks are real**, and the record below shows it.
2. **Reading policies doesn't catch them.** Supabase's Advisor missed CareNote's two worst leaks.
3. **We tested AI-written RLS 10 times, and it held up.** We only know because we attacked it.

**Red Row doesn't assume your RLS is broken. It finds out.**

## 1. RLS leaks are real
- **CVE-2025-48757 (CVSS 9.3, disputed by the supplier):** insufficient RLS policies in Supabase databases behind Lovable-generated sites let unauthenticated attackers read or write arbitrary tables. The supplier says each customer is responsible for their own data.
- **Moltbook (found by Wiz, 2026):** a "didn't write a single line of code" app exposed about 4.75M records incl. 1.5M API tokens: a Supabase key in client-side JavaScript, with no effective RLS behind it. https://wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys
- **Audit of vibe-coded apps (arXiv 2606.23130):** **91% of 200 audited apps** had at least one vulnerability, and **65.77%** of the vulnerabilities were Critical or High, concentrated in broken access control, injection and authentication failures.
- **LLM-generated access-control policies in general, not RLS specifically (arXiv 2609.24036, Sep 2026):** in this study of Rego policies, a single-prompt baseline got deny rules wrong **62.5%** of the time and missed ownership conditions **60%** of the time.

## 2. Reading policies doesn't catch them
Supabase Security Advisor is a static linter: it reads configuration, and it does flag several real problems (see the table). But it missed CareNote's two worst leaks. A policy like `using (true)` on SELECT for `authenticated` passes the linter, and still lets every signed-in user read every patient. Only an actual attack proves it. **Advisor checks configuration. Red Row checks behavior.**

Supabase's Advisor reads policy text. Red Row logs in and tries.

| Leak on the CareNote demo | Supabase Advisor | Red Row |
|---|---|---|
| Read other doctors' patients: `patients` SELECT `using (true)` | not flagged | 🔓 80 rows |
| Delete other doctors' notes: `visit_notes` DELETE `using (auth.role() = 'authenticated')` | not flagged | 🔓 240 rows |
| Weak rule on note updates: `visit_notes` UPDATE without `WITH CHECK` | not flagged | Warned, attack blocked |
| Strangers read every profile: RLS disabled on `profiles` | flagged | 🔓 3 rows |
| Add appointments as another doctor: `appointments` INSERT `WITH CHECK (true)` | flagged | 🔓 allowed |
| View skips RLS: security definer view `patient_summary` | flagged | Found in schema |
| Function runs as its owner: `search_patients` security definer + mutable `search_path` | flagged | Found in schema |
| Leaked password protection off | flagged | Not checked |

Advisor run on Nov 4, 2026. Red Row doesn't check `search_path` or auth settings, so use both tools.

## 3. We tested AI-written RLS 10 times, and it held up
We asked Claude Sonnet 5.5 for 5 Supabase schemas with no security hints, then gave it 5 real permission errors to fix, each with a tempting unsafe shortcut. On our review, no cross-user leak appeared in any of them, and it refused the shortcut every time.

We only know because we attacked it: Red Row's scans of all 10, plus hand-written attacks on the new functions in the fix round, which Red Row doesn't probe. That's one model and 10 samples, so it doesn't show AI-written RLS is always safe. It's why you test yours instead of assuming either way. Full method and limits: [`RESULTS.md`](../experiments/ai-rls/RESULTS.md).

## How it works (30-second version)
1. Introspect catalog: tables, grants, policies, views, SECURITY DEFINER functions.
2. Pick real owner ids from the data, or pin one by email (ids only, never row contents).
3. In a transaction: `set local role authenticated`, set `request.jwt.claims` to user A, try to read/insert/update/delete other users' rows. Count what succeeds. **Rollback.** The attack's changes never commit; sequence values and outside effects from triggers are the documented exceptions.
4. Score 0–100, leak matrix, and `npm run fix` writes a migration: from Claude if an API key is set (schema + policy text only, never data), from rule-based templates if not.

## Judging map (25% each)
| Criterion | What we show |
|---|---|
| Data quality | HQ is insert-only for API roles, constrained, written about every minute by a pg_cron sweep, and watched by Sodabase |
| Built to scale | HQ schema: every FK + policy column indexed, `(select auth.uid())`, forced RLS, scan tables written only by edge functions. **Red Row scans HQ → 100.** |
| Execution | Live: scan CareNote → red → fix → rescan green, end to end, on stage |
| Craft | Clone and run, open source (MIT), beautiful HTML report + live dashboard |

## 3-minute demo script
The exact commands, with reset steps, are in [`DEMO.md`](DEMO.md).

**Before going on,** load the URL into the terminal, because `.env` doesn't reach your shell. This prints nothing. In PowerShell, run this and then use `$env:DEMO_DB_URL` wherever the script says `$DEMO_DB_URL`:
```powershell
$env:DEMO_DB_URL = (Select-String -Path .env -Pattern '^DEMO_DB_URL=').Line.Split('=', 2)[1]
```

1. **(0:00) Hook.** "This is CareNote, a clinic app with the mistakes AI-built apps get caught with. Supabase's Advisor flags some of it, and misses the two worst leaks."
2. **(0:25) Attack.** Run `npm run scan -- --db $DEMO_DB_URL`. Terminal turns red: score 0/F. "Logged in as Dr. Ana, I can read **80 of other doctors' patients**, and delete **240 of their notes**. A stranger who isn't even logged in can read every clinician's email."
3. **(1:05) Matrix.** Dashboard: leak matrix (Stranger / Dr. Ana / Dr. Ana → other doctors × tables × read/insert/update/delete). Red cells with row counts. Invoices row is green — "the one table with no leaks."
4. **(1:35) Fix.** `npm run scan -- --db $DEMO_DB_URL --json > redrow-report.json`, then `npm run fix -- --db $DEMO_DB_URL --from redrow-report.json --apply -y`. Show the generated migration, every block labeled with the rule it fixes. Terminal rescan → 100/A straight away. The dashboard dial follows when the next sweep lands, up to about a minute later.
5. **(2:10) Safety.** "Every attack runs inside a transaction that's rolled back. We read counts and owner ids, never row contents, and the attacks never commit."
6. **(2:30) Scale + data quality.** "And our own backend? Red Row scans it about every minute: 100. And Sodabase watches our scan history." Show both.
7. **(2:50) Close.** "We tested AI-written RLS 10 times. It held up, and we only know because we attacked it. Red Row doesn't assume your RLS is broken. It finds out. Clone it and `npm run scan`. Open source today."

## Likely judge questions
- **"Did AI write CareNote?"** No. We wrote it by hand to be leaky, with the kinds of mistakes in the incidents above. When we asked AI for real schemas, they held up.
- **"So is AI-written RLS safe?"** In our 10 tests of one model, yes. That's too few to generalize, and it's the reason to test yours.
- **"Why did a safe app score low?"** The score counts schema findings, like `SECURITY DEFINER` functions, as well as proven leaks, and access the app intends counts too, so a safe app can score low. Our chat experiment scored 0/F because members can read each other's messages. Read the "Who got into what" map and the proven leaks first, then judge them against what the app should allow. On the roadmap: intent rules in plain English, so only access that breaks intent is flagged. That isn't built yet.
- **"Isn't that CVE disputed?"** Yes, the supplier disputes it. Even setting that CVE aside, the pattern is documented across many incidents and in the audits above.
- **"Isn't this Security Advisor?"** Advisor = static config lint. We prove exploitability with real counts, including two leaks that lint clean (`using (true)` on SELECT, and a DELETE with no ownership check), and generate the fix. A missing `with check` is a warning only: on CareNote that attack is blocked. Advisor also covers things we don't, like `search_path` and auth settings, so use both.
- **"Is it safe?"** The attacks never commit, and we read counts and owner ids, never row contents. Every probe is inside `begin … rollback`, with 5s statement timeout and 1s lock timeout. `--read-only` skips writes entirely. We never select row contents.
- **"Where should I run it?"** Run it against a staging project or a Supabase branch; the guard refuses production-looking targets by default, and triggers/sequences are the documented exceptions to rollback.
- **"What about complex policies (joins, teams)?"** Probes are behavioral, so they test what the policy does however complex it is, as long as Red Row can tell who owns a row. Ownership detection uses FKs to `auth.users`, with `ownerColumns` and `tenants` in the config for other schemas.
- **"Why the Sodabase angle?"** Scan history is data we want to trust: insert-only, constrained, continuously fresh.
