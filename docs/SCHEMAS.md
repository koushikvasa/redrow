# Schemas — HQ (dashboard) and CareNote (demo target)

Two separate Supabase projects. HQ must be **clean** (scores 100 on Red Row, scores well on Sodabase). CareNote must be **deliberately leaky** (scores 0, then 100 after `redrow fix`).

---

## A. HQ project (`redrow-hq`) — connected to Sodabase

### Design rules (these ARE the "Built to scale" + "Data quality" score)
- **Insert-only.** Every table has `created_at timestamptz not null default now()`. No `updated_at`-only tables. Never UPDATE or DELETE rows. A scan is immutable history.
- Constraints everywhere: `not null`, `check`, FKs with explicit `on delete`, unique where natural.
- An index on **every FK column** and every column used in an RLS policy, plus `(…, created_at desc)` composite indexes for the dashboard's "latest first" queries.
- RLS **enabled and forced** on every table. Policies use `(select auth.uid())`. No `using (true)`.
- Writes from the outside world only go through edge functions using the service role. The browser gets read-only access.
- Seed about **14 days of backdated history** so Sodabase freshness can reconstruct normal immediately.

### Migration `hq/supabase/migrations/0001_init.sql`

```sql
create extension if not exists pgcrypto;

-- A project = a database Red Row watches. Owned by a dashboard user.
create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 80),
  host_masked text not null,                       -- e.g. aws-0-us-east-1.pooler.supabase.com (no password, ever)
  is_public   boolean not null default false,      -- public demo board for judges
  created_at  timestamptz not null default now(),
  unique (owner_id, name)
);
create index projects_owner_id_idx on public.projects (owner_id);
create index projects_public_idx   on public.projects (is_public) where is_public;

-- One row per scan. Immutable.
create table public.scan_runs (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  source         text not null check (source in ('cli','sweep','ci','dashboard','seed')),  -- seed = backfilled history, not a real scan
  engine_version text not null,
  score          smallint not null check (score between 0 and 100),
  grade          char(1) not null check (grade in ('A','B','C','D','F')),
  critical       smallint not null default 0 check (critical >= 0),
  high           smallint not null default 0 check (high >= 0),
  medium         smallint not null default 0 check (medium >= 0),
  low            smallint not null default 0 check (low >= 0),
  tables_scanned smallint not null check (tables_scanned >= 0),
  probes_run     integer  not null check (probes_run >= 0),
  duration_ms    integer  not null check (duration_ms >= 0),
  created_at     timestamptz not null default now()
);
create index scan_runs_project_created_idx on public.scan_runs (project_id, created_at desc);

-- Findings of a scan. Immutable.
create table public.findings (
  id           uuid primary key default gen_random_uuid(),
  scan_run_id  uuid not null references public.scan_runs(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade, -- denormalized for RLS + fast filters
  rule_id      text not null check (rule_id ~ '^RR[0-9]{3}$'),
  severity     text not null check (severity in ('critical','high','medium','low','info')),  -- info = declared exposure
  schema_name  text not null,
  table_name   text,
  title        text not null,
  detail       text not null,
  rows_exposed integer check (rows_exposed is null or rows_exposed >= 0),
  fix_hint     text not null,
  created_at   timestamptz not null default now()
);
create index findings_scan_run_idx        on public.findings (scan_run_id);
create index findings_project_created_idx on public.findings (project_id, created_at desc);
create index findings_rule_idx            on public.findings (rule_id);

-- Probe matrix cells (who × table × action). Immutable. Counts only, never row data.
create table public.probe_results (
  id          uuid primary key default gen_random_uuid(),
  scan_run_id uuid not null references public.scan_runs(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  table_name  text not null,
  actor       text not null check (actor in ('anon','user_a','user_b')),
  action      text not null check (action in ('select_own','select_others','select_all','insert_other','update_other','delete_other','update_any','delete_any')),
  outcome     text not null check (outcome in ('allowed','denied','inconclusive','not_applicable')),
  row_count   integer check (row_count is null or row_count >= 0),
  created_at  timestamptz not null default now()
);
create index probe_results_scan_run_idx        on public.probe_results (scan_run_id);
create index probe_results_project_created_idx on public.probe_results (project_id, created_at desc);

-- RLS
alter table public.projects      enable row level security;
alter table public.scan_runs     enable row level security;
alter table public.findings      enable row level security;
alter table public.probe_results enable row level security;
alter table public.projects      force row level security;
alter table public.scan_runs     force row level security;
alter table public.findings      force row level security;
alter table public.probe_results force row level security;

-- Read: owners see their projects; anyone sees projects marked public (the judges' board).
create policy projects_read on public.projects for select to anon, authenticated
  using (is_public or owner_id = (select auth.uid()));
create policy projects_insert on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy scan_runs_read on public.scan_runs for select to anon, authenticated
  using (exists (select 1 from public.projects p where p.id = project_id
                 and (p.is_public or p.owner_id = (select auth.uid()))));
create policy findings_read on public.findings for select to anon, authenticated
  using (exists (select 1 from public.projects p where p.id = project_id
                 and (p.is_public or p.owner_id = (select auth.uid()))));
create policy probe_results_read on public.probe_results for select to anon, authenticated
  using (exists (select 1 from public.projects p where p.id = project_id
                 and (p.is_public or p.owner_id = (select auth.uid()))));
-- No insert/update/delete policies on scan tables: only the service role (edge functions) writes.

-- Least privilege grants
revoke all on public.projects, public.scan_runs, public.findings, public.probe_results from anon, authenticated;
grant select on public.projects, public.scan_runs, public.findings, public.probe_results to anon, authenticated;
grant insert on public.projects to authenticated;

-- Realtime for the live dashboard
alter publication supabase_realtime add table public.scan_runs, public.findings;
```

### Edge functions (`hq/supabase/functions/`)
- **`ingest`** — POST a `Report` (the `redrow scan --json` shape, ENGINE.md §5) with header `x-redrow-key` (per-project ingest key stored as a Supabase secret for the hackathon). Validates shape, inserts `scan_runs` + `findings` + `probe_results` in one transaction. Used by `redrow scan --upload`.
- **`sweep`** — called by `pg_cron` every minute, one request a minute, because two sent in the same instant stalled in `pg_net`'s DNS lookup. Connects to the CareNote demo DB (`DEMO_DB_URL` secret) and to HQ through its session pooler (`HQ_POOLER_DB_URL`, because a scan over `SUPABASE_DB_URL` never finishes on the edge), runs the engine (`_shared/engine`), inserts results. This is both a real feature ("continuous red-team") and what keeps HQ tables fresh for Sodabase. When scanning HQ, it passes `publicTables: ['projects']`, because the judges' board is meant to be readable by anon.

### Reaching 100 on the self-scan
`projects_read` lets anon read `is_public` rows on purpose, so without a declaration RR101 fires and HQ scores 75. The CLI gets this from `hq/redrow.config.json`, kept apart from the root config, where it would hide anon reads on anyone's own `projects` table. With `projects` in `publicTables`, that read is reported as declared exposure (`info`) and scores nothing. A signed-in user seeing a public project owned by someone else adds nothing beyond that, so RR102 is ignored as long as, for every owner, they see no more of that owner's rows than anon does. If they see more, it still counts.

### Cron (`0002_cron.sql`)
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('redrow-sweep', '* * * * *', $$
  select net.http_post(
    url     := 'https://<HQ_REF>.supabase.co/functions/v1/sweep',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sweep_token'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);  -- a sweep takes several seconds, well past the 5s default
$$);
```

### Seed (`hq/scripts/seed-history.mjs`)
Creates the public demo projects ("CareNote demo", "Red Row HQ (self-scan)") and backfills **one scan every 15 minutes for 14 days** with realistic score drift (CareNote hovering 0–10, HQ 100). Uses explicit `created_at` values in the past, and `source = 'seed'` so backfilled rows can never be mistaken for real scans; the dashboard labels them. Inserts only.

---

## B. CareNote demo target (`carenote-demo`) — deliberately leaky

A plausible "AI-built" clinic notes app: what Lovable/Bolt/Cursor would generate. Every bug here is a real-world pattern. Each is labeled with the rule that should catch it.

### `demo-target/supabase/leaky.sql`

```sql
create extension if not exists pgcrypto;

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null,
  email      text not null,
  role       text not null default 'clinician' check (role in ('clinician','admin')),
  created_at timestamptz not null default now()
);

create table public.patients (
  id           uuid primary key default gen_random_uuid(),
  clinician_id uuid not null references auth.users(id),
  full_name    text not null,
  dob          date not null,
  phone        text,
  created_at   timestamptz not null default now()
);

create table public.visit_notes (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patients(id) on delete cascade,
  author_id    uuid not null references auth.users(id),
  diagnosis    text not null,
  note         text not null,
  created_at   timestamptz not null default now()
);

create table public.appointments (
  id           uuid primary key default gen_random_uuid(),
  patient_id   uuid not null references public.patients(id) on delete cascade,
  clinician_id uuid not null references auth.users(id),
  starts_at    timestamptz not null,
  created_at   timestamptz not null default now()
);

create table public.invoices (
  id         uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  owner_id   uuid not null references auth.users(id),
  amount     numeric(10,2) not null,
  created_at timestamptz not null default now()
);

-- BUG 1 (RR001 / RR101): RLS never enabled on profiles → emails public to anon.
-- (no alter table ... enable row level security)

-- BUG 2 (RR003 / RR102): RLS on, but "authenticated can read" means EVERY clinician reads EVERY patient.
alter table public.patients enable row level security;
create policy "Authenticated users can view patients" on public.patients
  for select to authenticated using (true);
create policy "Users can insert patients" on public.patients
  for insert to authenticated with check (clinician_id = auth.uid());   -- RR008: bare auth.uid()

-- BUG 3 (RR004): update scoped by USING with no explicit WITH CHECK. Postgres reuses USING as the check, so this
-- can't re-assign a note, but the rule is only implied. (RR103 on CareNote comes from profiles, which has RLS off.)
alter table public.visit_notes enable row level security;
create policy "Authors read own notes" on public.visit_notes
  for select to authenticated using (author_id = auth.uid());
create policy "Authors update own notes" on public.visit_notes
  for update to authenticated using (author_id = auth.uid());
-- BUG 4 (RR104): delete policy uses role-level check instead of ownership.
create policy "Clinicians can delete notes" on public.visit_notes
  for delete to authenticated using (auth.role() = 'authenticated');

-- BUG 5 (RR005 / RR105): insert with no ownership check → book appointments as another clinician.
alter table public.appointments enable row level security;
create policy "Read own appointments" on public.appointments
  for select to authenticated using (clinician_id = auth.uid());
create policy "Anyone signed in can book" on public.appointments
  for insert to authenticated with check (true);

-- BUG 6 (RR006): convenience view, created by the postgres role, no security_invoker → bypasses RLS.
create view public.patient_summary as
  select p.id, p.full_name, p.dob, count(v.id) as note_count
  from public.patients p left join public.visit_notes v on v.patient_id = p.id
  group by p.id;

-- BUG 7 (RR007): SECURITY DEFINER search function callable by anon.
create function public.search_patients(q text) returns setof public.patients
language sql security definer as $$
  select * from public.patients where full_name ilike '%' || q || '%';
$$;

-- invoices is done correctly (control: should show green in the matrix)
alter table public.invoices enable row level security;
create policy invoices_owner_read on public.invoices
  for select to authenticated using (owner_id = (select auth.uid()));
create index invoices_owner_id_idx on public.invoices (owner_id);
-- BUG 8 (RR009): no index on patients.clinician_id / visit_notes.author_id used by policies.
```

### `demo-target/scripts/seed.mjs`
Uses the service role key + `auth.admin.createUser` to create **3 clinicians** (dr.ana, dr.ben, dr.cho @carenote.test), then inserts with obviously fake data: ~40 patients per clinician, ~3 notes per patient, appointments, invoices. Fake names only (e.g. "Test Patient 017"). Idempotent: deletes previous `@carenote.test` users first.

### `demo-target/supabase/reset.sql`
Drops and recreates everything from `leaky.sql` (so the stage demo can be replayed). Seed rerun after.

### `demo-target/supabase/fixed.sql` (reference answer; what `redrow fix` should roughly produce)
Enable RLS on profiles with owner policy; replace `using (true)` with `clinician_id = (select auth.uid())`; add `with check` on updates; ownership-scoped delete and insert; `alter view patient_summary set (security_invoker = true)`; `revoke execute on function search_patients(text) from anon, authenticated, public` (it skips RLS, so a clinician who could still call it would read every patient); indexes on `patients(clinician_id)`, `visit_notes(author_id)`, `appointments(clinician_id)`; wrap `auth.uid()` in `(select …)`. After applying, rescan must be 100/A.
