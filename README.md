# Red Row

**AI wrote your RLS. Red Row proves whether it leaks.**

**[See it live → redrow.vercel.app](https://redrow.vercel.app)**

Supabase's Security Advisor checks whether Row Level Security is *on*. Red Row checks whether it *works*: it attacks your database as real users, and reports what got through, with row counts.

| Leaking now | See it fixed |
|---|---|
| ![CareNote leaking: any logged-in doctor can read 80 of other doctors' patients and delete 240 of their notes. Score 0/F.](docs/img/carenote-leaking.png) | ![The same attacks with the fix applied: every attack blocked. Score 100/A.](docs/img/carenote-fixed.png) |

## Red Row vs Supabase's Advisor

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

## Quickstart

Needs Node 20+. Use the **Session pooler** connection string from Supabase → Connect (port 5432).

```bash
git clone https://github.com/koushikvasa/redrow && cd redrow
npm install
npm run scan -- --db "<session pooler url>" -y
```

`-y` confirms you mean this database. Red Row refuses a remote database otherwise, unless it's listed in `allowHosts` in `redrow.config.json`. No API key needed.

Red Row isn't on npm, so run it from a clone.

## How it works

1. **Signs in** as a stranger and as real users.
2. **Tries to read and change** other people's rows.
3. **Rolls everything back**, scores it 0–100, and writes the fix.

## Safety

- **Always rolled back.** Every attack runs in its own transaction that ends in `ROLLBACK`, with a 5s statement timeout and a 1s lock timeout.
- **Counts only.** It records row counts, owner ids and catalog metadata. It never reads or prints your row contents.
- **Your data stays home.** Claude only sees schema text, policy text and finding metadata, and only if you set an API key.
- **Opt out of writes.** `--read-only` skips every write attempt.
- **Asks before production.** Remote databases need `-y` or an `allowHosts` entry.

> **What a rollback can't undo:** sequence values, and outside effects from triggers and extensions such as `dblink` or `http`. If a trigger on your table calls out to another system, use `--read-only`.

## What it checks

**Read from your schema**

| Rule | Severity | Problem |
|---|---|---|
| RR001 | Critical | RLS disabled, and the table is publicly readable through the API |
| RR002 | High | RLS disabled on a table API roles can access |
| RR003 | High | Read policy matches every row (`USING true`) |
| RR004 | Medium | UPDATE policy has no explicit `WITH CHECK` |
| RR005 | Medium | INSERT policy doesn't check row ownership |
| RR006 | High | View bypasses RLS |
| RR007 | High | `SECURITY DEFINER` function callable from the API |
| RR008 | Low | Policy re-evaluates `auth.uid()` for every row |
| RR009 | Low | Owner column used in a policy has no index |
| RR010 | Medium | RLS enabled with no policies, so API roles see nothing |

**Proven by attacking**

| Rule | Severity | Who did what |
|---|---|---|
| RR101 | Critical | Anonymous users read an owned or sensitive table |
| RR102 | Critical | A signed-in user read other users' rows |
| RR103 | Critical | A signed-in user updated other users' rows |
| RR104 | Critical | A signed-in user deleted other users' rows |
| RR105 | High | A signed-in user inserted a row owned by someone else |
| RR106 | High | Anonymous users wrote to a table |

## Reports and fixes

```bash
npm run scan -- --db "<url>" -y --html report.html     # a self-contained page to share
npm run scan -- --db "<url>" -y --json > report.json   # the input for fix
npm run fix  -- --db "<url>" -y --from report.json     # writes redrow-fix-<timestamp>.sql
npm run fix  -- --db "<url>" --from report.json --apply   # asks y/N, applies, rescans
```

### How `fix` works

- **Who writes it:** Claude if `ANTHROPIC_API_KEY` is set, rule-based templates if not. The file's first line names the model that answered.
- **Parsed first:** every statement is checked against an allowlist. No `DROP TABLE`, no `GRANT`, no `COMMIT` hidden in the middle.
- **Limited in scope:** model-written SQL may only touch objects the report flagged.
- **Tried before it's written:** it runs in a transaction that's rolled back, so bad SQL never reaches the file.
- **Your call to apply:** `--apply` asks first, then rescans and prints before → after.

Read a model's migration before applying it. The checks judge what a statement is and what it touches, not whether its logic is right. [`docs/ENGINE.md`](docs/ENGINE.md) section 6 has the details.

### In CI

```bash
npm run scan -- --db "$DB_URL" -y --read-only --severity high
```

Exit codes: `0` nothing at or above `--severity`, `1` findings, `2` couldn't run or proved nothing.

## Architecture

```
                 your Supabase database
                           ▲
                           │  attacks, always rolled back
                           │
                    packages/engine
       introspect → static rules → probes → score
              ▲                        ▲
              │                        │
        packages/cli            hq sweep function
   terminal, JSON, HTML, fix    pg_cron, every minute
              │                        │
              │ --upload               │ counts only
              ▼                        ▼
       hq ingest function ──►  HQ database (Supabase)
                               insert-only, RLS forced
                                       │  Realtime
                                       ▼
                               apps/web on Vercel
                               redrow.vercel.app
```

The engine has no Node-only APIs and no database driver of its own, so the same build runs in the CLI and in Deno edge functions. HQ scans itself on the dashboard, and scores 100.

## Why this exists

- **[CVE-2025-48757](https://nvd.nist.gov/vuln/detail/CVE-2025-48757) (CVSS 9.3):** insufficient RLS in Lovable-generated sites let unauthenticated attackers read or write database tables. The supplier disputes it, saying each customer is responsible for their own data.
- **[Moltbook](https://wiz.io/blog/exposed-moltbook-database-reveals-millions-of-api-keys):** a Supabase key in client-side JavaScript with no effective RLS exposed about 4.75M records, including 1.5M API tokens.
- **[Understanding the (In)Security of Vibe-Coded Applications](https://arxiv.org/abs/2606.23130):** 91% of 200 audited apps had at least one vulnerability. 65.77% of those vulnerabilities were Critical or High, concentrated in broken access control, injection and authentication failures.
- **[Structured Decomposition for Reliable LLM-Generated Access Control Policies](https://arxiv.org/abs/2609.24036):** a single-prompt LLM baseline got deny rules right 37.5% of the time and ownership conditions 40% of the time. The policies were Rego, not RLS, but it's the same kind of mistake.

Red Row checks behavior, not configuration: a policy like `using (true)` is "on", passes a linter, and still lets every signed-in user read every row.

<details>
<summary><strong>Running your own HQ and dashboard</strong></summary>

HQ is a Supabase project. With its values in `.env` (see `.env.example`), and `<ref>` as its project ref:

```bash
npx supabase --workdir hq db push --db-url "$HQ_DB_URL"
npm run sync:engine
npx supabase --workdir hq secrets set --project-ref <ref> DEMO_DB_URL=... HQ_POOLER_DB_URL=... SWEEP_TOKEN=... REDROW_INGEST_KEY=...
npx supabase --workdir hq functions deploy ingest sweep --project-ref <ref> --use-api
node hq/scripts/seed-history.mjs
```

- Store the sweep token in Vault: `select vault.create_secret('<token>', 'sweep_token')`.
- Turn off email signups, or anyone could add projects to the public board.
- Each sweep writes about 100 rows. To stop them: `select cron.unschedule('redrow-sweep')`.
- Scan HQ itself: `npm run scan -- --config hq/redrow.config.json --db "$HQ_DB_URL"`.
- Send any scan to HQ: set `REDROW_INGEST_URL` and `REDROW_INGEST_KEY`, and add `--upload --project "<name>"`.
- Name the attackers: `personas` sets the words, and `actors` pins user A by email, keyed by project name or by `host/login`. The dashboard reads `hq/redrow.config.json`, so run `npm run sync:web` after changing it. The terminal reads whichever config it's given, and only uses a persona when its pinned user was found.

`apps/web` is a standalone Next.js app, kept out of the root workspace so that scanning from a clone doesn't download it. It reads HQ with the anon key only, so it shows what RLS shows anyone.

```bash
cd apps/web && npm install && npm run dev   # needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local
npx vercel --prod                           # deploys from apps/web
```

</details>

## Docs

- [`docs/ENGINE.md`](docs/ENGINE.md): rules, probes and scoring
- [`docs/SCHEMAS.md`](docs/SCHEMAS.md): the HQ schema and the deliberately leaky CareNote demo

## License

[MIT](LICENSE)
