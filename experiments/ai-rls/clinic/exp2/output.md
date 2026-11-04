## Why it fails

Your grants only allow authenticated users to update one column on `profiles`:

```sql
grant update (full_name) on public.profiles to authenticated;
```

So a client-side `update profiles set role = 'doctor'` is rejected, and that's the right behavior. The obvious fix, `grant update (role) ...`, would be a serious vulnerability. Any signed-in user could call the API and set `role = 'admin'`, which opens every appointment to them through `private.is_admin()`. Even limited to `'doctor'`, anyone could appear in the patient-facing directory as a doctor.

Also, setting `profiles.role` alone wouldn't work, because a `doctors` row is needed (specialty, slot length) for booking to function.

## Fix: signup requests a doctor role, an admin approves

The client calls a `security definer` function that records the request. Nothing privileged happens until an admin approves.

```sql
-- Applications table (no direct writes from clients)
create table public.doctor_applications (
  user_id              uuid primary key references public.profiles(id) on delete cascade,
  specialty            text not null check (char_length(specialty) between 1 and 100),
  consultation_minutes int  not null default 30 check (consultation_minutes between 5 and 240),
  status               text not null default 'pending'
                         check (status in ('pending', 'approved', 'rejected')),
  created_at           timestamptz not null default now(),
  reviewed_at          timestamptz,
  reviewed_by          uuid references public.profiles(id)
);

alter table public.doctor_applications enable row level security;

revoke all on public.doctor_applications from anon, authenticated;
grant select on public.doctor_applications to authenticated;

create policy "doctor_applications: read own"
  on public.doctor_applications for select to authenticated
  using (user_id = (select auth.uid()));

create policy "doctor_applications: admin read all"
  on public.doctor_applications for select to authenticated
  using (private.is_admin());

-- Called by the signup form
create or replace function public.request_doctor_role(
  p_specialty text, p_minutes int default 30)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.profiles where id = v_uid and role <> 'patient') then
    raise exception 'Account already has a role';
  end if;

  insert into public.doctor_applications (user_id, specialty, consultation_minutes)
  values (v_uid, left(trim(p_specialty), 100), p_minutes)
  on conflict (user_id) do update
    set specialty = excluded.specialty,
        consultation_minutes = excluded.consultation_minutes
    where public.doctor_applications.status = 'pending';  -- can edit while pending
end;
$$;

revoke all on function public.request_doctor_role(text, int) from public, anon;
grant execute on function public.request_doctor_role(text, int) to authenticated;

-- Called by an admin (from your admin UI)
create or replace function public.approve_doctor_application(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_app public.doctor_applications;
begin
  if not private.is_admin() then
    raise exception 'Not allowed';
  end if;

  select * into v_app
  from public.doctor_applications
  where user_id = p_user_id and status = 'pending';

  if not found then
    raise exception 'No pending application';
  end if;

  perform private.promote_to_doctor(v_app.user_id, v_app.specialty, v_app.consultation_minutes);

  update public.doctor_applications
  set status = 'approved', reviewed_at = now(), reviewed_by = (select auth.uid())
  where user_id = p_user_id;
end;
$$;

revoke all on function public.approve_doctor_application(uuid) from public, anon;
grant execute on function public.approve_doctor_application(uuid) to authenticated;
```

### Client code

Replace the `profiles` update with:

```js
const { error } = await supabase.rpc('request_doctor_role', {
  p_specialty: specialty,
  p_minutes: 30,
});
```

Show the user a "pending approval" message afterwards. They stay a `patient` until an admin calls `approve_doctor_application`. To reject, set `status = 'rejected'` from the SQL editor or an admin function.

## If you really want instant doctor signup

I'd advise against it for a medical app. If you accept the risk, make `request_doctor_role` call `private.promote_to_doctor(v_uid, p_specialty, p_minutes)` directly instead of inserting an application, keeping the `role = 'patient'` check. That way the role can only ever go patient → doctor, never to `admin`, and still never through a column grant on `profiles.role`.