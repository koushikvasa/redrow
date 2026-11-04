-- CareNote: a plausible AI-built clinic notes app, and deliberately leaky. Don't copy this.
-- Every bug is labeled with the rule that should catch it. See docs/SCHEMAS.md section B.
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
