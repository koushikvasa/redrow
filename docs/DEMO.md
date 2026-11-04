# The 3-minute demo

CareNote is a deliberately leaky clinic app on real Supabase. This takes it from 0/F to 100/A and back.

## Before you start

You need a clone with `npm install` done, and a `.env` with `DEMO_DB_URL` and the other values in [`.env.example`](../.env.example).

`.env` doesn't reach your shell, so load the database URL first. It prints nothing. In PowerShell:

```powershell
$env:DEMO_DB_URL = (Select-String -Path .env -Pattern '^DEMO_DB_URL=').Line.Split('=', 2)[1]
```

In bash:

```bash
export DEMO_DB_URL="$(grep '^DEMO_DB_URL=' .env | cut -d= -f2-)"
```

The commands below use the PowerShell form. In bash, write `"$DEMO_DB_URL"` instead.

Have https://redrow.vercel.app open on the CareNote page, on "Leaking now".

## Steps

### 0. Reset (before going on)

```powershell
npm run demo:reset
```

This rebuilds CareNote's leaky schema and its fake data. Do it before you go on, because the data takes a moment to reseed.

### 1. Attack (0:00–0:45)

```powershell
npm run scan -- --db $env:DEMO_DB_URL
```

The terminal turns red, with a score of 0/F. Logged in as Dr. Ana, Red Row reads 80 of other doctors' patients and deletes 240 of their notes, all rolled back. A stranger who isn't logged in reads every clinician's email.

### 2. Dashboard (0:45–1:35)

On the CareNote page, show three things:

- **The attack replay**, which plays the same attacks.
- **The "Red Row vs Supabase Advisor" panel.** The two headline leaks read "not flagged" against "🔓 80 rows" and "🔓 240 rows".
- **The leak matrix.** Invoices is the one table with no leaks.

### 3. Fix (1:35–2:10)

```powershell
npm run scan -- --db $env:DEMO_DB_URL --json > redrow-report.json
npm run fix -- --db $env:DEMO_DB_URL --from redrow-report.json --apply -y
```

This writes `redrow-fix-<timestamp>.sql`, with each block labeled by the rule it fixes, applies it, rescans, and prints before → after. Claude writes the migration if `ANTHROPIC_API_KEY` is set in your shell, and rule-based templates write it if not.

### 4. Rescan (2:10–2:30)

```powershell
npm run scan -- --db $env:DEMO_DB_URL
```

100/A. The dashboard follows when the next sweep lands, usually within a minute or two.

### 5. Close (2:30–3:00)

Show that Red Row scans its own backend: "Our own backend: 100/100" on the CareNote page links to it. Then the safety line: every attack runs in a transaction that's rolled back.

### 6. Reset (after you finish)

```powershell
npm run demo:reset
```

CareNote goes back to 0/F for the next run, and the next sweep shows it.

## Worth knowing

- **A sweep during the demo stays in the history.** HQ is insert-only, so a sweep that lands while CareNote is fixed leaves a real 100/A in its chart. To rehearse without that, pause the sweep first, as [`capture-fixed-reference.mjs`](../demo-target/scripts/capture-fixed-reference.mjs) does, and resume it after:

  ```sql
  select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'redrow-sweep'), active := false);
  ```

- **The comparison panel hides once CareNote is fixed.** Its counts come from a leaking scan, so it only shows while the live score is under 90. Show it in step 2.
- **Don't run `demo:capture-fixed` near a demo.** It pauses the sweep and resets CareNote.
