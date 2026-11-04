# Supabase schema: team task manager with RLS

Run this in the SQL Editor or save it as a migration.

```sql
-- =====================================================================
-- 0. Extensions / schemas
-- =====================================================================
-- Helper functions live in a schema that is NOT exposed through the API.
create schema if not exists private;
grant usage on schema private to authenticated;

-- =====================================================================
-- 1. Types
-- =====================================================================
create type public.team_role     as enum ('owner', 'admin', 'member');
create type public.task_status   as enum ('todo', 'in_progress', 'done', 'archived');
create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');

-- =====================================================================
-- 2. Tables
-- =====================================================================
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 100),
  created_by uuid not null default auth.uid() references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_members (
  team_id    uuid not null references public.teams (id) on delete cascade,
  user_id    uuid not null references auth.users (id)   on delete cascade,
  role       public.team_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.tasks (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 300),
  description text,
  status      public.task_status   not null default 'todo',
  priority    public.task_priority not null default 'medium',
  due_date    date,
  created_by  uuid not null default auth.uid() references auth.users (id),
  assigned_to uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Assignee must be a member of the same team (enforced at the DB level).
  -- If the member is removed, only assigned_to is nulled (Postgres 15+).
  constraint tasks_assignee_is_member
    foreign key (team_id, assigned_to)
    references public.team_members (team_id, user_id)
    on delete set null (assigned_to)
);

-- =====================================================================
-- 3. Indexes (also used by RLS lookups)
-- =====================================================================
create index team_members_user_id_idx    on public.team_members (user_id);
create index tasks_team_status_idx       on public.tasks (team_id, status);
create index tasks_assigned_to_idx       on public.tasks (assigned_to);
create index tasks_created_by_idx        on public.tasks (created_by);

-- =====================================================================
-- 4. RLS helper functions
--    SECURITY DEFINER so they can read team_members without triggering
--    recursive RLS. search_path is locked down.
-- =====================================================================
create or replace function private.is_team_member(_team_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = _team_id
      and user_id = (select auth.uid())
  );
$$;

create or replace function private.is_team_admin(_team_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = _team_id
      and user_id = (select auth.uid())
      and role in ('owner', 'admin')
  );
$$;

create or replace function private.is_team_owner(_team_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_id = _team_id
      and user_id = (select auth.uid())
      and role = 'owner'
  );
$$;

-- True if the current user shares at least one team with _user_id
create or replace function private.shares_team_with(_user_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.team_members me
    join public.team_members them using (team_id)
    where me.user_id   = (select auth.uid())
      and them.user_id = _user_id
  );
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- =====================================================================
-- 5. Triggers
-- =====================================================================

-- 5a. Create a profile when a user signs up
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name',
             new.raw_user_meta_data ->> 'full_name',
             split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 5b. Creator automatically becomes team owner
create or replace function private.add_creator_as_owner()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.team_members (team_id, user_id, role)
  values (new.id, new.created_by, 'owner');
  return new;
end;
$$;

create trigger on_team_created
  after insert on public.teams
  for each row execute function private.add_creator_as_owner();

-- 5c. updated_at maintenance
create or replace function private.set_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.teams
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();

-- 5d. Immutable columns (prevents moving rows across teams / spoofing authors)
create or replace function private.guard_task_update()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.team_id <> old.team_id or new.created_by <> old.created_by then
    raise exception 'team_id and created_by cannot be changed';
  end if;
  return new;
end;
$$;

create trigger guard_task_update before update on public.tasks
  for each row execute function private.guard_task_update();

create or replace function private.guard_member_update()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.team_id <> old.team_id or new.user_id <> old.user_id then
    raise exception 'team_id and user_id cannot be changed';
  end if;
  return new;
end;
$$;

create trigger guard_member_update before update on public.team_members
  for each row execute function private.guard_member_update();

-- =====================================================================
-- 6. Row Level Security
-- =====================================================================
alter table public.profiles     enable row level security;
alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.tasks        enable row level security;

-- Anonymous users get nothing; signed-in users are governed by policies.
revoke all on public.profiles, public.teams, public.team_members, public.tasks from anon;

-- ---------- profiles ----------
create policy "profiles: read self or teammates"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_team_with(id));

create policy "profiles: update self"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
-- No insert/delete policies: rows are created by trigger and removed by cascade.

-- ---------- teams ----------
-- created_by is included so `insert(...).select()` works right after creation
-- (the owner-membership row is added by an AFTER trigger).
create policy "teams: read own teams"
  on public.teams for select to authenticated
  using (private.is_team_member(id) or created_by = (select auth.uid()));

create policy "teams: create as self"
  on public.teams for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "teams: admins update"
  on public.teams for update to authenticated
  using (private.is_team_admin(id))
  with check (private.is_team_admin(id));

create policy "teams: owners delete"
  on public.teams for delete to authenticated
  using (private.is_team_owner(id));

-- ---------- team_members ----------
create policy "team_members: read own team's roster"
  on public.team_members for select to authenticated
  using (private.is_team_member(team_id));

-- Admins can add members; only owners can add other owners.
create policy "team_members: admins add"
  on public.team_members for insert to authenticated
  with check (
    private.is_team_owner(team_id)
    or (private.is_team_admin(team_id) and role <> 'owner')
  );

-- Owners can change anyone; admins can't touch or create owners.
create policy "team_members: admins update roles"
  on public.team_members for update to authenticated
  using (
    private.is_team_owner(team_id)
    or (private.is_team_admin(team_id) and role <> 'owner')
  )
  with check (
    private.is_team_owner(team_id)
    or (private.is_team_admin(team_id) and role <> 'owner')
  );

-- Members can leave; owners can remove anyone; admins can remove non-owners.
create policy "team_members: leave or remove"
  on public.team_members for delete to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_team_owner(team_id)
    or (private.is_team_admin(team_id) and role <> 'owner')
  );

-- ---------- tasks ----------
create policy "tasks: team members read"
  on public.tasks for select to authenticated
  using (private.is_team_member(team_id));

create policy "tasks: team members create"
  on public.tasks for insert to authenticated
  with check (
    private.is_team_member(team_id)
    and created_by = (select auth.uid())
  );

-- Creator, assignee, or team admins can edit.
create policy "tasks: creator, assignee or admin update"
  on public.tasks for update to authenticated
  using (
    private.is_team_member(team_id)
    and (
      created_by  = (select auth.uid())
      or assigned_to = (select auth.uid())
      or private.is_team_admin(team_id)
    )
  )
  with check (private.is_team_member(team_id));

-- Creator or team admins can delete.
create policy "tasks: creator or admin delete"
  on public.tasks for delete to authenticated
  using (
    private.is_team_member(team_id)
    and (
      created_by = (select auth.uid())
      or private.is_team_admin(team_id)
    )
  );
```

## Client usage (supabase-js)

```ts
// Create a team (trigger makes you the owner)
const { data: team } = await supabase
  .from('teams').insert({ name: 'Design' }).select().single();

// Create a task
await supabase.from('tasks').insert({
  team_id: team.id, title: 'Draft brand guidelines', assigned_to: user.id,
});

// Only returns tasks from teams you belong to
const { data: tasks } = await supabase
  .from('tasks')
  .select('*, assignee:profiles!tasks_assigned_to_fkey(display_name)')
  .order('created_at', { ascending: false });
```

The embedded `assignee:profiles!…` join only works if `tasks.assigned_to` has a foreign key to `profiles`. As written, the FK goes through `team_members`, so either fetch profiles separately or add `references public.profiles(id)` on `assigned_to`.

## Design notes

- **Membership is a join table** (`team_members`), so a user can belong to several teams, and each membership has a role (`owner`, `admin`, `member`).
- **No recursive RLS.** Policies on `team_members` call `SECURITY DEFINER` helpers in a non-exposed `private` schema, with `search_path = ''`.
- **`(select auth.uid())`** is wrapped in a subselect so Postgres evaluates it once per query rather than once per row.
- **Integrity is enforced in the database**, not only in policies:
  - The composite FK means a task can only be assigned to a member of its own team.
  - Triggers make `team_id` and `created_by` immutable, which stops tasks being moved between teams or authorship being spoofed.
- **Not included:**
  - An invitation flow. Adding someone to a team currently needs their `user_id`. The usual approach is a `team_invites` table plus a `SECURITY DEFINER` RPC (or an Edge Function) that accepts an invite token.
  - Last-owner protection. Add a trigger if you need to prevent a team from ending up with zero owners.