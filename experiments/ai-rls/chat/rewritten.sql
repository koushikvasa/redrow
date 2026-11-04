-- =====================================================================
-- 0. Helpers
-- =====================================================================
create or replace function app_chat.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- 1. Tables
-- =====================================================================

-- ---------- profiles ----------
create table app_chat.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique check (username ~ '^[a-z0-9_]{3,30}$'),
  display_name text check (char_length(display_name) <= 80),
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on app_chat.profiles
  for each row execute function app_chat.set_updated_at();

-- Auto-create a profile when a user signs up
create or replace function app_chat.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app_chat.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_chat.handle_new_user();

-- ---------- conversations ----------
create table app_chat.conversations (
  id              uuid primary key default gen_random_uuid(),
  type            text not null check (type in ('direct', 'group')),
  title           text check (char_length(title) between 1 and 100),
  -- For DMs: "<smaller uuid>:<larger uuid>" -> guarantees one DM per pair
  dm_key          text unique,
  created_by      uuid references app_chat.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz,
  constraint conversations_shape check (
    (type = 'direct' and dm_key is not null and title is null) or
    (type = 'group'  and dm_key is null)
  )
);

create trigger conversations_set_updated_at
  before update on app_chat.conversations
  for each row execute function app_chat.set_updated_at();

-- ---------- conversation_members ----------
create table app_chat.conversation_members (
  conversation_id uuid not null references app_chat.conversations (id) on delete cascade,
  user_id         uuid not null references app_chat.profiles (id) on delete cascade,
  role            text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index conversation_members_user_idx on app_chat.conversation_members (user_id);

-- ---------- messages ----------
create table app_chat.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references app_chat.conversations (id) on delete cascade,
  sender_id       uuid references app_chat.profiles (id) on delete set null,
  body            text not null check (char_length(btrim(body)) between 1 and 4000),
  reply_to        uuid,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  -- Lets us enforce "reply must be in the same conversation"
  unique (id, conversation_id),
  foreign key (reply_to, conversation_id)
    references app_chat.messages (id, conversation_id)
    on delete set null (reply_to)          -- requires Postgres 15+ (Supabase default)
);

create index messages_conversation_created_idx
  on app_chat.messages (conversation_id, created_at desc);

-- Mark edits
create or replace function app_chat.messages_mark_edited()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.body is distinct from old.body then
    new.edited_at = now();
  end if;
  return new;
end;
$$;

create trigger messages_mark_edited
  before update on app_chat.messages
  for each row execute function app_chat.messages_mark_edited();

-- Bump conversations.last_message_at (SECURITY DEFINER: clients can't update that column)
create or replace function app_chat.messages_bump_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app_chat.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_bump_conversation
  after insert on app_chat.messages
  for each row execute function app_chat.messages_bump_conversation();

-- =====================================================================
-- 2. RLS helper functions
--    SECURITY DEFINER avoids infinite recursion when policies on
--    conversation_members need to check conversation_members.
-- =====================================================================
create or replace function app_chat.has_conversation_role(conv_id uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from app_chat.conversation_members m
     where m.conversation_id = conv_id
       and m.user_id = auth.uid()
       and m.role = any (roles)
  );
$$;

create or replace function app_chat.is_conversation_member(conv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_chat.has_conversation_role(conv_id, array['owner', 'admin', 'member']);
$$;

create or replace function app_chat.is_group_conversation(conv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app_chat.conversations c
     where c.id = conv_id and c.type = 'group'
  );
$$;

-- Lock down execution (Supabase grants EXECUTE to anon by default)
revoke execute on function
  app_chat.has_conversation_role(uuid, text[]),
  app_chat.is_conversation_member(uuid),
  app_chat.is_group_conversation(uuid),
  app_chat.handle_new_user(),
  app_chat.messages_bump_conversation()
from public, anon;

grant execute on function
  app_chat.has_conversation_role(uuid, text[]),
  app_chat.is_conversation_member(uuid),
  app_chat.is_group_conversation(uuid)
to authenticated;

-- =====================================================================
-- 3. Table privileges (least privilege, column-level where it matters)
-- =====================================================================
revoke all on app_chat.profiles             from anon, authenticated;
revoke all on app_chat.conversations        from anon, authenticated;
revoke all on app_chat.conversation_members from anon, authenticated;
revoke all on app_chat.messages             from anon, authenticated;

grant select                                   on app_chat.profiles             to authenticated;
grant update (username, display_name, avatar_url) on app_chat.profiles          to authenticated;

grant select, delete                           on app_chat.conversations        to authenticated;
grant update (title)                           on app_chat.conversations        to authenticated;

grant select, insert, delete                   on app_chat.conversation_members to authenticated;
grant update (last_read_at)                    on app_chat.conversation_members to authenticated;

grant select, insert, delete                   on app_chat.messages             to authenticated;
grant update (body, deleted_at)                on app_chat.messages             to authenticated;

-- =====================================================================
-- 4. Row Level Security
-- =====================================================================
alter table app_chat.profiles             enable row level security;
alter table app_chat.conversations        enable row level security;
alter table app_chat.conversation_members enable row level security;
alter table app_chat.messages             enable row level security;

-- ---------- profiles ----------
-- Profiles are public to signed-in users (needed for user search / display names).
-- Don't put private data (email, phone) in this table.
create policy "profiles: read by authenticated"
  on app_chat.profiles for select to authenticated
  using (true);

create policy "profiles: update own"
  on app_chat.profiles for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- (No INSERT/DELETE policies: created by trigger, removed via auth.users cascade.)

-- ---------- conversations ----------
-- (No INSERT policy: conversations are created via the RPCs below.)
create policy "conversations: members can read"
  on app_chat.conversations for select to authenticated
  using (app_chat.is_conversation_member(id));

create policy "conversations: admins can update group"
  on app_chat.conversations for update to authenticated
  using      (app_chat.has_conversation_role(id, array['owner', 'admin']))
  with check (app_chat.has_conversation_role(id, array['owner', 'admin']));

create policy "conversations: owner can delete group"
  on app_chat.conversations for delete to authenticated
  using (app_chat.has_conversation_role(id, array['owner'])
         and app_chat.is_group_conversation(id));

-- ---------- conversation_members ----------
create policy "members: read members of my conversations"
  on app_chat.conversation_members for select to authenticated
  using (app_chat.is_conversation_member(conversation_id));

-- Admins can add plain members to GROUPS only
create policy "members: admins add members to groups"
  on app_chat.conversation_members for insert to authenticated
  with check (
    role = 'member'
    and app_chat.is_group_conversation(conversation_id)
    and app_chat.has_conversation_role(conversation_id, array['owner', 'admin'])
  );

-- Update own read marker only (column grant restricts to last_read_at)
create policy "members: update own read marker"
  on app_chat.conversation_members for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Leave a group, or admins remove plain members. DMs can't be left.
create policy "members: leave or remove"
  on app_chat.conversation_members for delete to authenticated
  using (
    app_chat.is_group_conversation(conversation_id)
    and (
      user_id = (select auth.uid())
      or (role = 'member'
          and app_chat.has_conversation_role(conversation_id, array['owner', 'admin']))
    )
  );

-- ---------- messages ----------
create policy "messages: members can read"
  on app_chat.messages for select to authenticated
  using (app_chat.is_conversation_member(conversation_id));

create policy "messages: members can send as themselves"
  on app_chat.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and app_chat.is_conversation_member(conversation_id)
  );

create policy "messages: edit own"
  on app_chat.messages for update to authenticated
  using (
    sender_id = (select auth.uid())
    and app_chat.is_conversation_member(conversation_id)
  )
  with check (
    sender_id = (select auth.uid())
    and app_chat.is_conversation_member(conversation_id)
  );

create policy "messages: delete own"
  on app_chat.messages for delete to authenticated
  using (sender_id = (select auth.uid()));

-- =====================================================================
-- 5. RPCs for creating conversations
-- =====================================================================
create or replace function app_chat.create_direct_conversation(other_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me      uuid := auth.uid();
  key     text;
  conv_id uuid;
begin
  if me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if other_user_id is null or other_user_id = me then
    raise exception 'Invalid user' using errcode = '22023';
  end if;
  if not exists (select 1 from app_chat.profiles where id = other_user_id) then
    raise exception 'User not found' using errcode = '22023';
  end if;

  key := least(me::text, other_user_id::text) || ':' || greatest(me::text, other_user_id::text);

  select id into conv_id from app_chat.conversations where dm_key = key;
  if conv_id is not null then
    return conv_id;
  end if;

  insert into app_chat.conversations (type, dm_key, created_by)
  values ('direct', key, me)
  on conflict (dm_key) do nothing
  returning id into conv_id;

  if conv_id is null then               -- lost a race; the other tx creates members
    select id into conv_id from app_chat.conversations where dm_key = key;
    return conv_id;
  end if;

  insert into app_chat.conversation_members (conversation_id, user_id)
  values (conv_id, me), (conv_id, other_user_id);

  return conv_id;
end;
$$;

create or replace function app_chat.create_group_conversation(
  group_title text,
  member_ids  uuid[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me      uuid := auth.uid();
  conv_id uuid;
begin
  if me is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if coalesce(array_length(member_ids, 1), 0) > 255 then
    raise exception 'Too many members' using errcode = '22023';
  end if;

  insert into app_chat.conversations (type, title, created_by)
  values ('group', group_title, me)
  returning id into conv_id;

  insert into app_chat.conversation_members (conversation_id, user_id, role)
  values (conv_id, me, 'owner');

  insert into app_chat.conversation_members (conversation_id, user_id, role)
  select conv_id, p.id, 'member'
    from app_chat.profiles p
   where p.id = any (member_ids)
     and p.id <> me
  on conflict do nothing;

  return conv_id;
end;
$$;

revoke execute on function
  app_chat.create_direct_conversation(uuid),
  app_chat.create_group_conversation(text, uuid[])
from public, anon;

grant execute on function
  app_chat.create_direct_conversation(uuid),
  app_chat.create_group_conversation(text, uuid[])
to authenticated;

-- =====================================================================
-- 6. Realtime (postgres_changes respects the SELECT policies above)
-- =====================================================================
alter publication supabase_realtime add table app_chat.messages;
alter publication supabase_realtime add table app_chat.conversation_members;
