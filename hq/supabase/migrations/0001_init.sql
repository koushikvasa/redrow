-- Red Row HQ: the scans behind the public dashboard. See docs/SCHEMAS.md section A.
-- Insert-only: a scan is immutable history, so nothing here is ever updated or deleted.
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

-- Probe matrix cells (who x table x action). Immutable. Counts only, never row data.
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
-- No insert/update/delete policies on scan tables: only the edge functions write.

-- Least privilege grants. Supabase grants anon and authenticated everything on new public tables.
revoke all on public.projects, public.scan_runs, public.findings, public.probe_results from anon, authenticated;
grant select on public.projects, public.scan_runs, public.findings, public.probe_results to anon, authenticated;
grant insert on public.projects to authenticated;

-- Realtime for the live dashboard
alter publication supabase_realtime add table public.scan_runs, public.findings;
