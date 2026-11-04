## Cause

Your `team_members` INSERT policy only allows people who are already an owner or admin of the team:

```sql
with check (
  private.is_team_owner(team_id)
  or (private.is_team_admin(team_id) and role <> 'owner')
)
```

A user accepting an invite isn't a member yet, so their insert fails. There is also no invite table in the schema to prove they were invited.

Don't loosen the policy to something like `user_id = auth.uid()`. That would let anyone add themselves to any team. The invite has to be validated and consumed atomically, so the right fix is an `invites` table plus a `SECURITY DEFINER` function that does the insert.

## Fix

```sql
-- =====================================================================
-- Invites
-- =====================================================================
create table public.team_invites (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams (id) on delete cascade,
  email       text not null check (char_length(email) between 3 and 320),
  role        public.team_role not null default 'member'
              check (role <> 'owner'),            -- invites can never create owners
  token       uuid not null unique default gen_random_uuid(),
  invited_by  uuid not null default auth.uid() references auth.users (id),
  expires_at  timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id),
  created_at  timestamptz not null default now()
);

-- One pending invite per email per team
create unique index team_invites_pending_uniq
  on public.team_invites (team_id, lower(email))
  where accepted_at is null;
create index team_invites_team_id_idx on public.team_invites (team_id);

alter table public.team_invites enable row level security;
revoke all on public.team_invites from anon;

-- Only team admins manage invites. Invitees never read this table directly;
-- they go through accept_team_invite() below.
create policy "team_invites: admins read"
  on public.team_invites for select to authenticated
  using (private.is_team_admin(team_id));

create policy "team_invites: admins create"
  on public.team_invites for insert to authenticated
  with check (
    private.is_team_admin(team_id)
    and role <> 'owner'
    and invited_by = (select auth.uid())
  );

create policy "team_invites: admins revoke"
  on public.team_invites for delete to authenticated
  using (private.is_team_admin(team_id));

-- =====================================================================
-- Accept an invite (must live in an API-exposed schema to be callable via RPC)
-- =====================================================================
create or replace function public.accept_team_invite(_token uuid)
returns uuid                       -- returns the team_id joined
language plpgsql
security definer
set search_path = ''
as $$
declare
  _uid   uuid := (select auth.uid());
  _email text;
  _inv   public.team_invites%rowtype;
begin
  if _uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Only a *verified* email may claim an email-bound invite
  select u.email into _email
  from auth.users u
  where u.id = _uid and u.email_confirmed_at is not null;

  -- Lock the row so concurrent accepts can't double-use it
  select * into _inv
  from public.team_invites
  where token = _token
  for update;

  if not found
     or _inv.accepted_at is not null
     or _inv.expires_at < now()
     or _email is null
     or lower(_inv.email) <> lower(_email)
  then
    -- Deliberately vague so tokens/emails can't be probed
    raise exception 'invalid or expired invite' using errcode = 'P0001';
  end if;

  insert into public.team_members (team_id, user_id, role)
  values (_inv.team_id, _uid, _inv.role)
  on conflict (team_id, user_id) do nothing;   -- already a member: keep existing role

  update public.team_invites
  set accepted_at = now(), accepted_by = _uid
  where id = _inv.id;

  return _inv.team_id;
end;
$$;

revoke all on function public.accept_team_invite(uuid) from public, anon;
grant execute on function public.accept_team_invite(uuid) to authenticated;
```

## Client usage

```ts
const { data: teamId, error } = await supabase.rpc('accept_team_invite', {
  _token: tokenFromInviteLink,
});
```

The user must be signed in first. If they have to sign up, keep the token through the signup and email-confirmation flow, then call the RPC.

## Design notes

- **Email-bound and verified.** The invite only works for the matching, confirmed email, so a leaked link is useless to anyone else. If you want link-only invites, remove the `_email` conditions, but then anyone with the link can join.
- **No owner invites.** Both the table check constraint and the insert policy block `role = 'owner'`.
- **Your existing `team_members` policies are unchanged.** The function runs as its owner, which bypasses RLS, and it validates everything itself.
- **Postgres 15+.** You already depend on this for `on delete set null (assigned_to)`.
- **Optional.** Add `private.shares_team_with`-style visibility for invitees, or a cleanup job for expired invites, if you need them.