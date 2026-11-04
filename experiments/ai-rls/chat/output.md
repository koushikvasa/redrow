# Supabase schema: private chat with RLS

This is one migration. It covers:

- Profiles linked to `auth.users`
- Direct (1:1) and group conversations
- Membership-based access, so only members can see a conversation or its messages
- RPCs for creating conversations, so clients can never add themselves to someone else's chat

```sql
-- =====================================================================
-- 0. Helpers
-- =====================================================================
create or replace function public.set_updated_at()
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
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique check (username ~ '^[a-z0-9_]{3,30}$'),
  display_name text check (char_length(display_name) <= 80),
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Auto-create a profile when a user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
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
  for each row execute function public.handle_new_user();

-- ---------- conversations ----------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  type            text not null check (type in ('direct', 'group')),
  title           text check (char_length(title) between 1 and 100),
  -- For DMs: "<smaller uuid>:<larger uuid>" -> guarantees one DM per pair
  dm_key          text unique,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz,
  constraint conversations_shape check (
    (type = 'direct' and dm_key is not null and title is null) or
    (type = 'group'  and dm_key is null)
  )
);

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ---------- conversation_members ----------
create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index conversation_members_user_idx on public.conversation_members (user_id);

-- ---------- messages ----------
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id       uuid references public.profiles (id) on delete set null,
  body            text not null check (char_length(btrim(body)) between 1 and 4000),
  reply_to        uuid,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,

  -- Lets us enforce "reply must be in the same conversation"
  unique (id, conversation_id),
  foreign key (reply_to, conversation_id)
    references public.messages (id, conversation_id)
    on delete set null (reply_to)          -- requires Postgres 15+ (Supabase default)
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

-- Mark edits
create or replace function public.messages_mark_edited()
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
  before update on public.messages
  for each row execute function public.messages_mark_edited();

-- Bump conversations.last_message_at (SECURITY DEFINER: clients can't update that column)
create or replace function public.messages_bump_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set last_message_at = new.created_at
   where id = new.conversation_id;
  return new;
end;
$$;

create trigger messages_bump_conversation
  after insert on public.messages
  for each row execute function public.messages_bump_conversation();

-- =====================================================================
-- 2. RLS helper functions
--    SECURITY DEFINER avoids infinite recursion when policies on
--    conversation_members need to check conversation_members.
-- =====================================================================
create or replace function public.has_conversation_role(conv_id uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.conversation_members m
     where m.conversation_id = conv_id
       and m.user_id = auth.uid()
       and m.role = any (roles)
  );
$$;

create or replace function public.is_conversation_member(conv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_conversation_role(conv_id, array['owner', 'admin', 'member']);
$$;

create or replace function public.is_group_conversation(conv_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
     where c.id = conv_id and c.type = 'group'
  );
$$;

-- Lock down execution (Supabase grants EXECUTE to anon by default)
revoke execute on function
  public.has_conversation_role(uuid, text[]),
  public.is_conversation_member(uuid),
  public.is_group_conversation(uuid),
  public.handle_new_user(),
  public.messages_bump_conversation()
from public, anon;

grant execute on function
  public.has_conversation_role(uuid, text[]),
  public.is_conversation_member(uuid),
  public.is_group_conversation(uuid)
to authenticated;

-- =====================================================================
-- 3. Table privileges (least privilege, column-level where it matters)
-- =====================================================================
revoke all on public.profiles             from anon, authenticated;
revoke all on public.conversations        from anon, authenticated;
revoke all on public.conversation_members from anon, authenticated;
revoke all on public.messages             from anon, authenticated;

grant select                                   on public.profiles             to authenticated;
grant update (username, display_name, avatar_url) on public.profiles          to authenticated;

grant select, delete                           on public.conversations        to authenticated;
grant update (title)                           on public.conversations        to authenticated;

grant select, insert, delete                   on public.conversation_members to authenticated;
grant update (last_read_at)                    on public.conversation_members to authenticated;

grant select, insert, delete                   on public.messages             to authenticated;
grant update (body, deleted_at)                on public.messages             to authenticated;

-- =====================================================================
-- 4. Row Level Security
-- =====================================================================
alter table public.profiles             enable row level security;
alter table public.conversations        enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages             enable row level security;

-- ---------- profiles ----------
-- Profiles are public to signed-in users (needed for user search / display names).
-- Don't put private data (email, phone) in this table.
create policy "profiles: read by authenticated"
  on public.profiles for select to authenticated
  using (true);

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- (No INSERT/DELETE policies: created by trigger, removed via auth.users cascade.)

-- ---------- conversations ----------
-- (No INSERT policy: conversations are created via the RPCs below.)
create policy "conversations: members can read"
  on public.conversations for select to authenticated
  using (public.is_conversation_member(id));

create policy "conversations: admins can update group"
  on public.conversations for update to authenticated
  using      (public.has_conversation_role(id, array['owner', 'admin']))
  with check (public.has_conversation_role(id, array['owner', 'admin']));

create policy "conversations: owner can delete group"
  on public.conversations for delete to authenticated
  using (public.has_conversation_role(id, array['owner'])
         and public.is_group_conversation(id));

-- ---------- conversation_members ----------
create policy "members: read members of my conversations"
  on public.conversation_members for select to authenticated
  using (public.is_conversation_member(conversation_id));

-- Admins can add plain members to GROUPS only
create policy "members: admins add members to groups"
  on public.conversation_members for insert to authenticated
  with check (
    role = 'member'
    and public.is_group_conversation(conversation_id)
    and public.has_conversation_role(conversation_id, array['owner', 'admin'])
  );

-- Update own read marker only (column grant restricts to last_read_at)
create policy "members: update own read marker"
  on public.conversation_members for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Leave a group, or admins remove plain members. DMs can't be left.
create policy "members: leave or remove"
  on public.conversation_members for delete to authenticated
  using (
    public.is_group_conversation(conversation_id)
    and (
      user_id = (select auth.uid())
      or (role = 'member'
          and public.has_conversation_role(conversation_id, array['owner', 'admin']))
    )
  );

-- ---------- messages ----------
create policy "messages: members can read"
  on public.messages for select to authenticated
  using (public.is_conversation_member(conversation_id));

create policy "messages: members can send as themselves"
  on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_conversation_member(conversation_id)
  );

create policy "messages: edit own"
  on public.messages for update to authenticated
  using (
    sender_id = (select auth.uid())
    and public.is_conversation_member(conversation_id)
  )
  with check (
    sender_id = (select auth.uid())
    and public.is_conversation_member(conversation_id)
  );

create policy "messages: delete own"
  on public.messages for delete to authenticated
  using (sender_id = (select auth.uid()));

-- =====================================================================
-- 5. RPCs for creating conversations
-- =====================================================================
create or replace function public.create_direct_conversation(other_user_id uuid)
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
  if not exists (select 1 from public.profiles where id = other_user_id) then
    raise exception 'User not found' using errcode = '22023';
  end if;

  key := least(me::text, other_user_id::text) || ':' || greatest(me::text, other_user_id::text);

  select id into conv_id from public.conversations where dm_key = key;
  if conv_id is not null then
    return conv_id;
  end if;

  insert into public.conversations (type, dm_key, created_by)
  values ('direct', key, me)
  on conflict (dm_key) do nothing
  returning id into conv_id;

  if conv_id is null then               -- lost a race; the other tx creates members
    select id into conv_id from public.conversations where dm_key = key;
    return conv_id;
  end if;

  insert into public.conversation_members (conversation_id, user_id)
  values (conv_id, me), (conv_id, other_user_id);

  return conv_id;
end;
$$;

create or replace function public.create_group_conversation(
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

  insert into public.conversations (type, title, created_by)
  values ('group', group_title, me)
  returning id into conv_id;

  insert into public.conversation_members (conversation_id, user_id, role)
  values (conv_id, me, 'owner');

  insert into public.conversation_members (conversation_id, user_id, role)
  select conv_id, p.id, 'member'
    from public.profiles p
   where p.id = any (member_ids)
     and p.id <> me
  on conflict do nothing;

  return conv_id;
end;
$$;

revoke execute on function
  public.create_direct_conversation(uuid),
  public.create_group_conversation(text, uuid[])
from public, anon;

grant execute on function
  public.create_direct_conversation(uuid),
  public.create_group_conversation(text, uuid[])
to authenticated;

-- =====================================================================
-- 6. Realtime (postgres_changes respects the SELECT policies above)
-- =====================================================================
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.conversation_members;
```

## Client usage

```ts
// Start / get a DM
const { data: convId } = await supabase.rpc('create_direct_conversation', { other_user_id })

// Create a group
await supabase.rpc('create_group_conversation', { group_title: 'Team', member_ids: [...] })

// Send a message (sender_id must equal your uid or RLS rejects it)
await supabase.from('messages').insert({ conversation_id, sender_id: user.id, body: 'hi' })

// Conversation list, newest activity first
await supabase
  .from('conversations')
  .select('*, conversation_members(user_id, profiles(username, display_name, avatar_url))')
  .order('last_message_at', { ascending: false, nullsFirst: false })
```

## Design notes

- **No direct insert on `conversations`.** If clients could insert conversations and members freely, anyone could add themselves to any conversation. Creation goes through `SECURITY DEFINER` RPCs that use `auth.uid()`.
- **Helper functions prevent RLS recursion.** A `conversation_members` policy that queries `conversation_members` directly would recurse infinitely. The helpers bypass RLS safely, with `search_path = ''` and only ever checking `auth.uid()`.
- **Column-level grants.** Even with an UPDATE policy, clients can only change `title`, `last_read_at`, `body`, `deleted_at` and profile fields. They can't change `sender_id`, `conversation_id`, `role` or `created_at`.
- **Replies stay in the conversation.** A composite foreign key blocks replying to a message in another conversation.
- **Direct conversations are fixed.** The `dm_key` guarantees one DM per pair, and DMs can't be left or have members added.
- **Realtime caveat.** Realtime `DELETE` events can't be filtered by RLS. Prefer soft deletes (`deleted_at`) and avoid putting sensitive data in rows you hard-delete.
- **Profile visibility.** All signed-in users can read profiles so user search works. To restrict this, change the profile `select` policy to only users who share a conversation with you, or search through an RPC.
- **Not included:** role promotion and demotion (add an owner-only RPC), blocking, attachments (use Storage with policies that check `is_conversation_member` on the path's conversation id), and read-receipt fan-out.