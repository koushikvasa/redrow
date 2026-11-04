-- =====================================================================
-- 0. Extensions, schemas, types
-- =====================================================================
create extension if not exists btree_gist;   -- needed for exclusion constraints

create schema if not exists app_clinic_private;         -- NOT exposed via the Data API
grant usage on schema app_clinic_private to authenticated;

create type app_clinic.user_role         as enum ('patient', 'doctor', 'admin');
create type app_clinic.appointment_status as enum
  ('requested', 'confirmed', 'completed', 'cancelled', 'no_show');

-- =====================================================================
-- 1. Tables
-- =====================================================================

-- One row per auth user. Holds only non-sensitive data (readable by doctors).
create table app_clinic.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       app_clinic.user_role not null default 'patient',
  full_name  text not null default '' check (char_length(full_name) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sensitive patient details.
create table app_clinic.patients (
  id                      uuid primary key references app_clinic.profiles(id) on delete cascade,
  date_of_birth           date,
  phone                   text check (char_length(phone) <= 30),
  insurance_number        text check (char_length(insurance_number) <= 100),
  emergency_contact_name  text check (char_length(emergency_contact_name) <= 200),
  emergency_contact_phone text check (char_length(emergency_contact_phone) <= 30),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Public doctor directory (no sensitive data here: readable by all signed-in users).
create table app_clinic.doctors (
  id                    uuid primary key references app_clinic.profiles(id) on delete cascade,
  specialty             text not null check (char_length(specialty) <= 100),
  bio                   text check (char_length(bio) <= 2000),
  consultation_minutes  int  not null default 30 check (consultation_minutes between 5 and 240),
  is_accepting_patients boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table app_clinic.appointments (
  id                  uuid primary key default gen_random_uuid(),
  patient_id          uuid not null references app_clinic.patients(id) on delete restrict,
  doctor_id           uuid not null references app_clinic.doctors(id)  on delete restrict,
  starts_at           timestamptz not null,
  ends_at             timestamptz not null,
  status              app_clinic.appointment_status not null default 'requested',
  reason              text check (char_length(reason) <= 1000),   -- visible to patient & doctor
  cancellation_reason text check (char_length(cancellation_reason) <= 1000),
  cancelled_by        uuid references app_clinic.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint appt_valid_range      check (ends_at > starts_at),
  constraint appt_not_self         check (patient_id <> doctor_id),
  constraint appt_id_doctor_unique unique (id, doctor_id),   -- for notes FK

  -- A doctor cannot have overlapping active appointments
  constraint appt_no_doctor_overlap exclude using gist (
    doctor_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('requested', 'confirmed')),

  -- A patient cannot be in two places at once
  constraint appt_no_patient_overlap exclude using gist (
    patient_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('requested', 'confirmed'))
);

create index appointments_patient_idx on app_clinic.appointments (patient_id, starts_at);
create index appointments_doctor_idx  on app_clinic.appointments (doctor_id,  starts_at);

-- Private clinical notes: only the treating doctor can access.
create table app_clinic.appointment_notes (
  id             uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique,
  doctor_id      uuid not null,
  note           text not null check (char_length(note) <= 20000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- guarantees the note's doctor is the appointment's doctor
  foreign key (appointment_id, doctor_id)
    references app_clinic.appointments (id, doctor_id) on delete cascade
);

-- =====================================================================
-- 2. Helper functions (private schema)
-- =====================================================================
create or replace function app_clinic_private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from app_clinic.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

revoke all on function app_clinic_private.is_admin() from public, anon;
grant execute on function app_clinic_private.is_admin() to authenticated;

create or replace function app_clinic_private.set_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger set_updated_at before update on app_clinic.profiles
  for each row execute function app_clinic_private.set_updated_at();
create trigger set_updated_at before update on app_clinic.patients
  for each row execute function app_clinic_private.set_updated_at();
create trigger set_updated_at before update on app_clinic.doctors
  for each row execute function app_clinic_private.set_updated_at();
create trigger set_updated_at before update on app_clinic.appointment_notes
  for each row execute function app_clinic_private.set_updated_at();

-- =====================================================================
-- 3. Signup trigger: every new auth user becomes a *patient*.
--    The role is never read from user-supplied metadata.
-- =====================================================================
create or replace function app_clinic_private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into app_clinic.profiles (id, full_name)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 200)
  );
  insert into app_clinic.patients (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_clinic_private.handle_new_user();

-- Run from SQL editor / service role only (not exposed via the API).
create or replace function app_clinic_private.promote_to_doctor(
  p_user_id uuid, p_specialty text, p_minutes int default 30)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update app_clinic.profiles set role = 'doctor' where id = p_user_id;
  insert into app_clinic.doctors (id, specialty, consultation_minutes)
  values (p_user_id, p_specialty, p_minutes)
  on conflict (id) do update set specialty = excluded.specialty;
end;
$$;
revoke all on function app_clinic_private.promote_to_doctor(uuid, text, int) from public, anon, authenticated;

-- =====================================================================
-- 4. Appointment business-rule triggers
-- =====================================================================

-- 4a. On insert: derive end time from the doctor's slot length (patients can't
--     book arbitrarily long blocks) and cap open bookings per patient.
create or replace function app_clinic_private.appointments_before_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_minutes    int;
  v_active     int;
  v_privileged boolean := (select auth.uid()) is null or app_clinic_private.is_admin();
begin
  select consultation_minutes into v_minutes
  from app_clinic.doctors where id = new.doctor_id;

  if v_minutes is null then
    raise exception 'Unknown doctor';
  end if;

  if not v_privileged or new.ends_at is null then
    new.ends_at := new.starts_at + make_interval(mins => v_minutes);
  end if;

  if not v_privileged then
    select count(*) into v_active
    from app_clinic.appointments
    where patient_id = new.patient_id
      and status in ('requested', 'confirmed')
      and starts_at > now();

    if v_active >= 5 then
      raise exception 'Too many upcoming appointments (max 5)';
    end if;
  end if;

  return new;
end;
$$;

create trigger appointments_before_insert
  before insert on app_clinic.appointments
  for each row execute function app_clinic_private.appointments_before_insert();

-- 4b. On update: enforce who may change what (RLS can't do column rules).
create or replace function app_clinic_private.appointments_before_update()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  new.updated_at := now();

  -- Service role / SQL editor, and admins: unrestricted (but keep audit field right)
  if v_uid is null or app_clinic_private.is_admin() then
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      new.cancelled_by := coalesce(v_uid, new.cancelled_by);
    end if;
    return new;
  end if;

  -- Immutable for patients and doctors (reschedule = cancel + rebook)
  if new.id <> old.id
     or new.patient_id <> old.patient_id
     or new.doctor_id  <> old.doctor_id
     or new.starts_at  <> old.starts_at
     or new.ends_at    <> old.ends_at then
    raise exception 'Appointment participants and times cannot be changed';
  end if;

  if old.status in ('completed', 'cancelled', 'no_show') then
    raise exception 'Appointment is closed and can no longer be modified';
  end if;

  if v_uid = old.patient_id then
    -- Patients may only cancel (or edit the reason while it is open)
    if new.status <> old.status then
      if new.status <> 'cancelled' then
        raise exception 'Patients can only cancel appointments';
      end if;
      if old.starts_at <= now() then
        raise exception 'Cannot cancel an appointment that has already started';
      end if;
    end if;

  elsif v_uid = old.doctor_id then
    new.reason := old.reason;  -- patient's text is read-only for doctors
    if new.status <> old.status then
      if not (
        (old.status = 'requested' and new.status in ('confirmed', 'cancelled')) or
        (old.status = 'confirmed' and new.status in ('completed', 'no_show', 'cancelled'))
      ) then
        raise exception 'Invalid status transition % -> %', old.status, new.status;
      end if;
      if new.status in ('completed', 'no_show') and old.starts_at > now() then
        raise exception 'Cannot complete a future appointment';
      end if;
    end if;

  else
    raise exception 'Not allowed';
  end if;

  -- Audit fields can't be forged
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    new.cancelled_by := v_uid;
  else
    new.cancelled_by := old.cancelled_by;
    new.cancellation_reason := old.cancellation_reason;
  end if;

  return new;
end;
$$;

create trigger appointments_before_update
  before update on app_clinic.appointments
  for each row execute function app_clinic_private.appointments_before_update();

-- =====================================================================
-- 5. Privileges (defense in depth on top of RLS)
-- =====================================================================
revoke all on app_clinic.profiles, app_clinic.patients, app_clinic.doctors,
              app_clinic.appointments, app_clinic.appointment_notes
  from anon, authenticated;

grant select on app_clinic.profiles, app_clinic.patients, app_clinic.doctors to authenticated;
grant update (full_name) on app_clinic.profiles to authenticated;
grant update (date_of_birth, phone, insurance_number,
              emergency_contact_name, emergency_contact_phone)
  on app_clinic.patients to authenticated;
grant update (specialty, bio, consultation_minutes, is_accepting_patients)
  on app_clinic.doctors to authenticated;

grant select, insert, update, delete on app_clinic.appointments to authenticated;  -- narrowed by RLS + triggers
grant select, insert, update, delete on app_clinic.appointment_notes to authenticated;

-- =====================================================================
-- 6. Row Level Security
-- =====================================================================
alter table app_clinic.profiles          enable row level security;
alter table app_clinic.patients          enable row level security;
alter table app_clinic.doctors           enable row level security;
alter table app_clinic.appointments      enable row level security;
alter table app_clinic.appointment_notes enable row level security;

-- ---------- profiles ----------
create policy "profiles: read own"
  on app_clinic.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles: anyone signed in can read doctors"
  on app_clinic.profiles for select to authenticated
  using (role = 'doctor');

create policy "profiles: doctors read their patients"
  on app_clinic.profiles for select to authenticated
  using (exists (
    select 1 from app_clinic.appointments a
    where a.patient_id = profiles.id and a.doctor_id = (select auth.uid())
  ));

create policy "profiles: admin read all"
  on app_clinic.profiles for select to authenticated
  using (app_clinic_private.is_admin());

create policy "profiles: update own"
  on app_clinic.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));   -- role is protected by column grants

-- ---------- patients ----------
create policy "patients: read own"
  on app_clinic.patients for select to authenticated
  using (id = (select auth.uid()));

create policy "patients: doctors read their patients"
  on app_clinic.patients for select to authenticated
  using (exists (
    select 1 from app_clinic.appointments a
    where a.patient_id = patients.id and a.doctor_id = (select auth.uid())
  ));

create policy "patients: admin read all"
  on app_clinic.patients for select to authenticated
  using (app_clinic_private.is_admin());

create policy "patients: update own"
  on app_clinic.patients for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------- doctors (public directory) ----------
create policy "doctors: directory readable by signed-in users"
  on app_clinic.doctors for select to authenticated
  using (true);

create policy "doctors: update own"
  on app_clinic.doctors for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---------- appointments ----------
create policy "appointments: participants read"
  on app_clinic.appointments for select to authenticated
  using (
    patient_id = (select auth.uid())
    or doctor_id = (select auth.uid())
  );

create policy "appointments: admin all"
  on app_clinic.appointments for all to authenticated
  using (app_clinic_private.is_admin())
  with check (app_clinic_private.is_admin());

create policy "appointments: patient books for self"
  on app_clinic.appointments for insert to authenticated
  with check (
    patient_id = (select auth.uid())
    and status = 'requested'
    and starts_at > now()
    and exists (
      select 1 from app_clinic.doctors d
      where d.id = doctor_id and d.is_accepting_patients
    )
  );

-- Field-level limits are enforced by appointments_before_update
create policy "appointments: patient updates own (cancel)"
  on app_clinic.appointments for update to authenticated
  using (patient_id = (select auth.uid()))
  with check (patient_id = (select auth.uid()));

create policy "appointments: doctor updates own"
  on app_clinic.appointments for update to authenticated
  using (doctor_id = (select auth.uid()))
  with check (doctor_id = (select auth.uid()));
-- No delete policy for patients/doctors: cancel instead of delete.

-- ---------- appointment_notes (doctor only) ----------
create policy "notes: treating doctor full access"
  on app_clinic.appointment_notes for all to authenticated
  using (doctor_id = (select auth.uid()))
  with check (doctor_id = (select auth.uid()));

-- =====================================================================
-- 7. Availability without leaking other patients' data
--    Patients can't read other appointments, so expose only busy time ranges.
-- =====================================================================
create or replace function app_clinic.get_doctor_busy_slots(
  p_doctor_id uuid, p_from timestamptz, p_to timestamptz)
returns table (starts_at timestamptz, ends_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select a.starts_at, a.ends_at
  from app_clinic.appointments a
  where a.doctor_id = p_doctor_id
    and a.status in ('requested', 'confirmed')
    and a.starts_at < p_to
    and a.ends_at   > p_from
    and p_to - p_from <= interval '31 days'
  order by a.starts_at;
$$;

revoke all on function app_clinic.get_doctor_busy_slots(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function app_clinic.get_doctor_busy_slots(uuid, timestamptz, timestamptz) to authenticated;
