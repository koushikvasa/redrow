-- The reference answer for CareNote: what `redrow fix` should roughly produce.
-- Apply it to the seeded leaky schema. invoices was already right, so it isn't touched.

-- RR001 / RR101: RLS on profiles, with an owner policy.
alter table public.profiles enable row level security;
create policy profiles_owner on public.profiles
  for all to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- RR003 / RR102 / RR008: patients scoped to their clinician.
drop policy "Authenticated users can view patients" on public.patients;
drop policy "Users can insert patients" on public.patients;
create policy patients_owner_read on public.patients
  for select to authenticated using (clinician_id = (select auth.uid()));
create policy patients_owner_insert on public.patients
  for insert to authenticated with check (clinician_id = (select auth.uid()));

-- RR004 / RR104 / RR008: notes scoped to their author, with an explicit WITH CHECK.
drop policy "Authors read own notes" on public.visit_notes;
drop policy "Authors update own notes" on public.visit_notes;
drop policy "Clinicians can delete notes" on public.visit_notes;
create policy notes_owner_read on public.visit_notes
  for select to authenticated using (author_id = (select auth.uid()));
create policy notes_owner_update on public.visit_notes
  for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
create policy notes_owner_delete on public.visit_notes
  for delete to authenticated using (author_id = (select auth.uid()));

-- RR005 / RR105 / RR008: appointments booked only as yourself.
drop policy "Read own appointments" on public.appointments;
drop policy "Anyone signed in can book" on public.appointments;
create policy appointments_owner_read on public.appointments
  for select to authenticated using (clinician_id = (select auth.uid()));
create policy appointments_owner_insert on public.appointments
  for insert to authenticated with check (clinician_id = (select auth.uid()));

-- RR006: the view now runs with the caller's rights, so RLS applies.
alter view public.patient_summary set (security_invoker = true);

-- RR007: anon can no longer call the SECURITY DEFINER search.
revoke execute on function public.search_patients(text) from anon, public;

-- RR009: an index on every owner column used by a policy.
create index patients_clinician_id_idx on public.patients (clinician_id);
create index visit_notes_author_id_idx on public.visit_notes (author_id);
create index appointments_clinician_id_idx on public.appointments (clinician_id);
