-- =====================================================================
-- Helpers
-- =====================================================================

create or replace function app_notes.set_updated_at()
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
-- Tables
-- =====================================================================

-- Profiles (1:1 with auth.users) ---------------------------------------
create table app_notes.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Folders ---------------------------------------------------------------
create table app_notes.folders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid()
               references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),          -- target for composite FKs (ownership integrity)
  unique (user_id, name)
);

-- Notes -------------------------------------------------------------------
create table app_notes.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid()
                references auth.users (id) on delete cascade,
  folder_id   uuid,
  title       text not null default '' check (char_length(title) <= 300),
  content     text not null default '' check (char_length(content) <= 200000),
  is_pinned   boolean not null default false,
  is_archived boolean not null default false,
  deleted_at  timestamptz,       -- soft delete / trash
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')),   'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) stored,

  unique (id, user_id),

  -- A note can only live in a folder owned by the same user.
  -- (Column-list SET NULL requires Postgres 15+, which Supabase uses.)
  foreign key (folder_id, user_id)
    references app_notes.folders (id, user_id)
    on delete set null (folder_id)
);

-- Tags --------------------------------------------------------------------
create table app_notes.tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid()
               references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 50),
  created_at timestamptz not null default now(),
  unique (id, user_id),
  unique (user_id, name)
);

-- Note <-> Tag join ---------------------------------------------------------
create table app_notes.note_tags (
  note_id    uuid not null,
  tag_id     uuid not null,
  user_id    uuid not null default auth.uid()
               references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (note_id, tag_id),

  -- Composite FKs guarantee note, tag, and link all belong to the same user
  foreign key (note_id, user_id) references app_notes.notes (id, user_id) on delete cascade,
  foreign key (tag_id,  user_id) references app_notes.tags  (id, user_id) on delete cascade
);

-- =====================================================================
-- Indexes
-- =====================================================================

create index notes_user_updated_idx
  on app_notes.notes (user_id, updated_at desc)
  where deleted_at is null;

create index notes_user_folder_idx on app_notes.notes (user_id, folder_id);
create index notes_search_idx      on app_notes.notes using gin (search);
create index folders_user_idx      on app_notes.folders (user_id);
create index tags_user_idx         on app_notes.tags (user_id);
create index note_tags_tag_idx     on app_notes.note_tags (tag_id);
create index note_tags_user_idx    on app_notes.note_tags (user_id);

-- =====================================================================
-- Triggers
-- =====================================================================

create trigger profiles_set_updated_at before update on app_notes.profiles
  for each row execute function app_notes.set_updated_at();

create trigger folders_set_updated_at before update on app_notes.folders
  for each row execute function app_notes.set_updated_at();

create trigger notes_set_updated_at before update on app_notes.notes
  for each row execute function app_notes.set_updated_at();

-- Auto-create a profile when a user signs up
create or replace function app_notes.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app_notes.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name',
             new.raw_user_meta_data ->> 'full_name'),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

revoke execute on function app_notes.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app_notes.handle_new_user();

-- =====================================================================
-- Row Level Security
-- =====================================================================

alter table app_notes.profiles  enable row level security;
alter table app_notes.folders   enable row level security;
alter table app_notes.notes     enable row level security;
alter table app_notes.tags      enable row level security;
alter table app_notes.note_tags enable row level security;

-- Anonymous users get nothing
revoke all on app_notes.profiles, app_notes.folders, app_notes.notes,
              app_notes.tags, app_notes.note_tags from anon;

-- NOTE: `(select auth.uid())` lets Postgres cache the value per statement
-- instead of re-evaluating it for every row.

-- profiles -------------------------------------------------------------------
-- (No INSERT policy: rows are created by the trigger. No DELETE policy:
--  profiles are removed via cascade when the auth user is deleted.)
create policy "profiles: select own"
  on app_notes.profiles for select to authenticated
  using ((select auth.uid()) = id);

create policy "profiles: update own"
  on app_notes.profiles for update to authenticated
  using      ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- folders --------------------------------------------------------------------
create policy "folders: select own"
  on app_notes.folders for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "folders: insert own"
  on app_notes.folders for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "folders: update own"
  on app_notes.folders for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "folders: delete own"
  on app_notes.folders for delete to authenticated
  using ((select auth.uid()) = user_id);

-- notes ----------------------------------------------------------------------
create policy "notes: select own"
  on app_notes.notes for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "notes: insert own"
  on app_notes.notes for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "notes: update own"
  on app_notes.notes for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "notes: delete own"
  on app_notes.notes for delete to authenticated
  using ((select auth.uid()) = user_id);

-- tags -----------------------------------------------------------------------
create policy "tags: select own"
  on app_notes.tags for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "tags: insert own"
  on app_notes.tags for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "tags: update own"
  on app_notes.tags for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "tags: delete own"
  on app_notes.tags for delete to authenticated
  using ((select auth.uid()) = user_id);

-- note_tags (no UPDATE: just add/remove links) -------------------------------
create policy "note_tags: select own"
  on app_notes.note_tags for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "note_tags: insert own"
  on app_notes.note_tags for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "note_tags: delete own"
  on app_notes.note_tags for delete to authenticated
  using ((select auth.uid()) = user_id);
