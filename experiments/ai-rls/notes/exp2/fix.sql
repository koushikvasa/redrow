-- =====================================================================
-- Friendships (skip if you already have an equivalent)
-- =====================================================================
create table public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  check (requester_id <> addressee_id),
  unique (requester_id, addressee_id)
);

create index friendships_addressee_idx on public.friendships (addressee_id);

alter table public.friendships enable row level security;
revoke all on public.friendships from anon;

create policy "friendships: select involved"
  on public.friendships for select to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- You can only send pending requests as yourself
create policy "friendships: request"
  on public.friendships for insert to authenticated
  with check ((select auth.uid()) = requester_id and status = 'pending');

-- Only the addressee can accept (and only the status column is updatable)
create policy "friendships: accept"
  on public.friendships for update to authenticated
  using ((select auth.uid()) = addressee_id)
  with check ((select auth.uid()) = addressee_id);

revoke update on public.friendships from authenticated;
grant  update (status) on public.friendships to authenticated;

create policy "friendships: delete involved"
  on public.friendships for delete to authenticated
  using ((select auth.uid()) in (requester_id, addressee_id));

-- =====================================================================
-- share_note(): copy one of my notes into a friend's account
-- =====================================================================
create or replace function public.share_note(p_note_id uuid, p_recipient_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sender uuid := auth.uid();
  v_new_id uuid;
begin
  if v_sender is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_recipient_id = v_sender then
    raise exception 'Cannot share a note with yourself' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = v_sender and f.addressee_id = p_recipient_id)
        or (f.requester_id = p_recipient_id and f.addressee_id = v_sender))
  ) then
    raise exception 'Recipient is not your friend' using errcode = '42501';
  end if;

  -- Only copies a note the caller owns. Folder, tags, pin, and archive state
  -- are deliberately NOT copied (they belong to the sender's organization).
  insert into public.notes (user_id, title, content)
  select p_recipient_id, n.title, n.content
  from public.notes n
  where n.id = p_note_id
    and n.user_id = v_sender
    and n.deleted_at is null
  returning id into v_new_id;

  if v_new_id is null then
    raise exception 'Note not found' using errcode = 'P0002';
  end if;

  return v_new_id;
end;
$$;

-- Supabase grants execute to anon/public by default; lock it down
revoke execute on function public.share_note(uuid, uuid) from public, anon;
grant  execute on function public.share_note(uuid, uuid) to authenticated;
