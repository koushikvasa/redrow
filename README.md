# Red Row

**AI wrote your RLS. Red Row proves whether it leaks.**

AI app builders generate Supabase schemas and Row Level Security policies that compile, pass linting, and still leak. Supabase's Security Advisor checks whether RLS is on. Red Row checks whether it works: it signs in as anon and as real users, tries to read and change other people's rows, and reports what it managed to do, with row counts.

Every attack runs in a transaction that is always rolled back. Nothing persists, and we only ever record counts.

## Quickstart

Needs Node 20+. Use the **Session pooler** connection string from Supabase → Connect (port 5432).

```bash
git clone https://github.com/koushikvasa/redrow && cd redrow && npm install && npm run scan -- --db "<session pooler url>"
```

Red Row won't attack a remote database whose name doesn't contain `test`, `demo` or `staging` until you say so, and every Supabase database is named `postgres`. So on Supabase, add `-y` to confirm you mean this one, or list it in `allowHosts` in `redrow.config.json`:

```bash
npm run scan -- --db "<session pooler url>" -y
```

Red Row isn't published to npm, so run it from a clone.

## Write a report, then fix it

```bash
npm run scan -- --db "<url>" -y --html report.html        # a self-contained page to share
npm run scan -- --db "<url>" -y --json > report.json      # the input for fix
npm run fix -- --db "<url>" -y --from report.json         # writes redrow-fix-<timestamp>.sql
npm run fix -- --db "<url>" --from report.json --apply    # asks y/N, applies, rescans (-y skips the question)
```

`npm install` prints nothing while it works: the repo's `.npmrc` silences npm, because otherwise npm echoes `--db` and its password on every run. You can also put the URL in `.env` as `REDROW_DB_URL` and leave `--db` off.

With `ANTHROPIC_API_KEY` set, Claude writes the migration, and its first line names the model that answered. Without a key, rule-based templates do it. Claude only sees finding metadata and catalog text, never your rows. Either way the SQL is parsed against an allowlist and tried in a rolled-back transaction before it's written. Read a model's migration before you apply it. `docs/ENGINE.md` section 6 says what those checks do and don't catch.

Exit codes: `0` nothing at or above `--severity`, `1` findings, `2` couldn't run, or every probe was inconclusive.

## Safety

- Every probe runs inside a transaction that ends in `ROLLBACK`, with a 5s statement timeout and a 1s lock timeout.
- It records counts, owner ids and catalog metadata. It never reads or prints row contents.
- `--read-only` skips every write probe.
- A rollback can't undo sequence values, or outside effects from triggers and extensions such as `dblink` or `http`.

## How it's built

```
packages/engine   introspect → static rules → probes → score. Runs in Node and Deno.
packages/cli      the redrow command: terminal, JSON and HTML reports, fix
hq/               the Supabase project behind the dashboard: schema, ingest and sweep functions
apps/web          the live dashboard
demo-target/      CareNote, a deliberately leaky app to attack
```

`docs/ENGINE.md` has the rules and scoring, and `docs/SCHEMAS.md` has the schemas.

## License

MIT
