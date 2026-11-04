-- Removes everything leaky.sql and fixed.sql create, so the stage demo can be replayed.
-- `npm run demo:reset` runs this, then leaky.sql, then the seed. Users in auth.users stay until the seed replaces them.
drop view if exists public.patient_summary;
drop function if exists public.search_patients(text);
drop table if exists public.invoices;
drop table if exists public.appointments;
drop table if exists public.visit_notes;
drop table if exists public.patients;
drop table if exists public.profiles;
