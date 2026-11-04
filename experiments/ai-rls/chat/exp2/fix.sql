-- =====================================================================
-- Group invites
-- =====================================================================
create table public.group_invites (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  -- unguessable token (~244 bits of randomness)
  code            text not null unique
                    default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  created_by      uuid default auth.uid() references public.profiles (id) on delete set null,
  expires_at      timestamptz,
  max_uses        int check (max_uses > 0),
  use_count       int not null default 0,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index group_invites_conversation_idx on public.group_invites (conversation_id);

-- Privileges: clients can create (limited columns), read, revoke, delete.
revoke all on public.group_invites from anon, authenticated;
grant select, delete on public.group_invites to authenticated;
grant insert (conversation_id, expires_at, max_uses) on public.group_invites to authenticated;
grant update (revoked_at) on public.group_invites to authenticated;

alter table public.group_invites enable row level security;

create policy "invites: admins read"
  on public.group_invites for select to authenticated
  using (public.has_conversation_role(conversation_id, array['owner', 'admin']));

create policy "invites: admins create for groups"
  on public.group_invites for insert to authenticated
  with check (
    public.is_group_conversation(conversation_id)
    and public.has_conversation_role(conversation_id, array['owner', 'admin'])
  );

create policy "invites: admins revoke"
  on public.group_invites for update to authenticated
  using      (public.has_conversation_role(conversation_id, array['owner', 'admin']))
  with check (public.has_conversation_role(conversation_id, array['owner', 'admin']));

create policy "invites: admins delete"
  on public.group_invites for delete to authenticated
  using (public.has_conversation_role(conversation_id, array['owner', 'admin']));

-- =====================================================================
-- Redeem an invite (the actual "join" action)
-- =====================================================================
create or replace function public.join_group_via_invite(invite_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me       uuid := auth.uid();
  inv      public.group_invites%rowtype;
  inserted int;
begin
  if me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  -- Lock the row so max_uses can't be exceeded by concurrent joins
  select * into inv
    from public.group_invites
   where code = invite_code
   for update;

  if not found
     or inv.revoked_at is not null
     or (inv.expires_at is not null and inv.expires_at <= now())
     or (inv.max_uses  is not null and inv.use_count >= inv.max_uses)
     or not public.is_group_conversation(inv.conversation_id)
  then
    raise exception 'Invite is invalid or has expired' using errcode = '22023';
  end if;

  -- Already a member: succeed without consuming a use
  if exists (
    select 1 from public.conversation_members
     where conversation_id = inv.conversation_id and user_id = me
  ) then
    return inv.conversation_id;
  end if;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (inv.conversation_id, me, 'member')
  on conflict do nothing;

  get diagnostics inserted = row_count;

  if inserted > 0 then
    update public.group_invites
       set use_count = use_count + 1
     where id = inv.id;
  end if;

  return inv.conversation_id;
end;
$$;

-- =====================================================================
-- Preview (non-members can't SELECT the conversation, so expose minimal info)
-- =====================================================================
create or replace function public.get_invite_preview(invite_code text)
returns table (conversation_id uuid, title text, member_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.title,
         (select count(*) from public.conversation_members m where m.conversation_id = c.id)
    from public.group_invites i
    join public.conversations c on c.id = i.conversation_id
   where i.code = invite_code
     and c.type = 'group'
     and i.revoked_at is null
     and (i.expires_at is null or i.expires_at > now())
     and (i.max_uses  is null or i.use_count < i.max_uses);
$$;

revoke execute on function
  public.join_group_via_invite(text),
  public.get_invite_preview(text)
from public, anon;

grant execute on function
  public.join_group_via_invite(text),
  public.get_invite_preview(text)
to authenticated;
