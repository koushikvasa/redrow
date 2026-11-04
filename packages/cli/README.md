# Red Row

**AI wrote your RLS. Red Row proves whether it leaks.**

Red Row attacks your Supabase Row Level Security as a stranger and as real users, and reports what got through, with row counts.

```bash
npx redrow scan --db "<session pooler url>" --read-only -y
```

Use the **Session pooler** connection string from Supabase → Connect (port 5432). Needs Node 20.12+. `--read-only` skips every write attempt. `-y` confirms you mean this database.

Without `--read-only`, write attempts run inside transactions that are always rolled back. Sequence values and outside effects from triggers and extensions are the exceptions, so point it at a staging project or a branch where you can.

Red Row reads counts, owner ids and catalog metadata, never your row contents.

**Reading the score:** it counts schema findings as well as proven leaks, and access your app intends counts too, so a safe app can score low. Read what got through first, and judge it against what your app should allow.

- [Live demo](https://redrow.vercel.app)
- [Source, rules and docs](https://github.com/koushikvasa/redrow)

MIT licensed.
