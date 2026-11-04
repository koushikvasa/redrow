# Supabase marketplace schema with RLS

## Design summary

| Concept | Implementation |
|---|---|
| Buyers | Every authenticated user, via `profiles`, which is auto-created on signup |
| Sellers | A user who creates a `sellers` row (1 store per user). It starts as `pending` and an admin or service role activates it |
| Orders | One order belongs to one buyer and one seller. Line items snapshot title and price |
| Writes | Sensitive writes go through `place_order()` (security definer) or column-level grants, not open table access |
| Admin | `app_metadata.role = 'admin'` in the JWT. Users can't edit this, only the service role can |
| Payment | `paid` and `refunded` statuses are set only by your backend using the service role (e.g. a Stripe webhook) |

```sql
-- =====================================================================
-- 0. Setup
-- =====================================================================
create extension if not exists pgcrypto;

create schema if not exists private;
grant usage on schema private to authenticated;

-- =====================================================================
-- 1. Types
-- =====================================================================
create type public.seller_status as enum ('pending', 'active', 'suspended');

create type public.order_status as enum (
  'pending',      -- created, awaiting payment
  'paid',         -- set by backend (service role) after payment confirmed
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded'      -- set by backend (service role)
);

-- =====================================================================
-- 2. Tables
-- =====================================================================

-- 2.1 Profiles (1:1 with auth.users) ----------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 2.2 Sellers (a user can own at most one store) ----------------------
create table public.sellers (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null unique references public.profiles (id) on delete cascade,
  store_name  text not null check (char_length(store_name) between 2 and 80),
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text,
  logo_url    text,
  status      public.seller_status not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 2.3 Products --------------------------------------------------------
create table public.products (
  id           uuid primary key default gen_random_uuid(),
  seller_id    uuid not null references public.sellers (id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 200),
  description  text,
  price_cents  bigint not null check (price_cents >= 0),
  currency     char(3) not null default 'USD' check (currency = upper(currency)),
  stock        integer not null default 0 check (stock >= 0),
  is_active    boolean not null default true,
  images       text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 2.4 Orders ----------------------------------------------------------
create table public.orders (
  id                uuid primary key default gen_random_uuid(),
  buyer_id          uuid not null references public.profiles (id) on delete restrict,
  seller_id         uuid not null references public.sellers (id) on delete restrict,
  status            public.order_status not null default 'pending',
  total_cents       bigint not null check (total_cents >= 0),
  currency          char(3) not null,
  shipping_address  jsonb not null,
  payment_intent_id text,                       -- written by backend only
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- 2.5 Order items (price/title snapshot) ------------------------------
create table public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders (id) on delete cascade,
  product_id       uuid references public.products (id) on delete set null,
  title            text not null,
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  quantity         integer not null check (quantity > 0)
);

-- =====================================================================
-- 3. Indexes (FKs + policy/filter columns)
-- =====================================================================
create index sellers_status_idx          on public.sellers (status);
create index products_seller_id_idx      on public.products (seller_id);
create index products_active_idx         on public.products (created_at desc) where is_active;
create index orders_buyer_idx            on public.orders (buyer_id, created_at desc);
create index orders_seller_idx           on public.orders (seller_id, created_at desc);
create index order_items_order_id_idx    on public.order_items (order_id);
create index order_items_product_id_idx  on public.order_items (product_id);

-- =====================================================================
-- 4. Helper functions (private schema, not exposed through the API)
-- =====================================================================

-- Seller id owned by the current user (any status)
create or replace function private.current_seller_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select id from public.sellers where owner_id = (select auth.uid());
$$;

-- Seller id owned by the current user, only if the store is active
create or replace function private.current_active_seller_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select id from public.sellers
  where owner_id = (select auth.uid()) and status = 'active';
$$;

-- Admin flag from app_metadata (only settable server-side)
create or replace function private.is_admin()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin';
$$;

revoke all on function private.current_seller_id()        from public, anon;
revoke all on function private.current_active_seller_id() from public, anon;
revoke all on function private.is_admin()                 from public, anon;
grant execute on function private.current_seller_id()        to authenticated;
grant execute on function private.current_active_seller_id() to authenticated;
grant execute on function private.is_admin()                 to authenticated;

-- =====================================================================
-- 5. Triggers
-- =====================================================================

-- 5.1 updated_at -------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.sellers
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.products
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.orders
  for each row execute function private.set_updated_at();

-- 5.2 Auto-create profile on signup -----------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name',
             new.raw_user_meta_data ->> 'name',
             split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 5.3 Order status state machine --------------------------------------
-- Client roles (buyer / seller) may only perform specific transitions.
-- auth.uid() IS NULL means a trusted backend (service role / SQL editor).
create or replace function private.guard_order_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_is_buyer  boolean;
  v_is_seller boolean;
begin
  if v_uid is null then
    return new;
  end if;

  -- Defense in depth on top of column-level grants
  if new.id               is distinct from old.id
  or new.buyer_id         is distinct from old.buyer_id
  or new.seller_id        is distinct from old.seller_id
  or new.total_cents      is distinct from old.total_cents
  or new.currency         is distinct from old.currency
  or new.shipping_address is distinct from old.shipping_address
  or new.payment_intent_id is distinct from old.payment_intent_id then
    raise exception 'Only the order status can be modified' using errcode = '42501';
  end if;

  if new.status = old.status then
    return new;
  end if;

  v_is_buyer  := old.buyer_id = v_uid;
  v_is_seller := exists (
    select 1 from public.sellers s
    where s.id = old.seller_id and s.owner_id = v_uid
  );

  if v_is_buyer and old.status = 'pending' and new.status = 'cancelled' then
    return new;
  end if;

  if v_is_seller and (old.status, new.status) in (
       ('paid',       'processing'),
       ('processing', 'shipped'),
       ('shipped',    'delivered'),
       ('paid',       'cancelled'),
       ('processing', 'cancelled')
  ) then
    return new;
  end if;

  raise exception 'Illegal order status transition: % -> %', old.status, new.status
    using errcode = '42501';
end;
$$;

create trigger guard_order_update
  before update on public.orders
  for each row execute function private.guard_order_update();

-- 5.4 Restock when an unfulfilled order is cancelled -------------------
create or replace function private.restock_on_cancel()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.products p
  set stock = p.stock + oi.quantity
  from public.order_items oi
  where oi.order_id = new.id
    and oi.product_id = p.id;
  return new;
end;
$$;

create trigger restock_on_cancel
  after update of status on public.orders
  for each row
  when (old.status in ('pending', 'paid') and new.status = 'cancelled')
  execute function private.restock_on_cancel();

-- =====================================================================
-- 6. place_order(): the only way for clients to create orders
--    Prices come from the DB, never from the client. Stock is locked
--    and decremented atomically.
-- =====================================================================
create or replace function public.place_order(
  p_items            jsonb,   -- [{"product_id": "...", "quantity": 2}, ...]
  p_shipping_address jsonb    -- {"name": "...", "line1": "...", ...}
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_my_seller uuid;
  v_item      record;
  v_product   record;
  v_seller_id uuid;
  v_currency  char(3);
  v_total     bigint := 0;
  v_lines     jsonb  := '[]'::jsonb;
  v_order_id  uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order must contain at least one item' using errcode = '22023';
  end if;

  if jsonb_typeof(p_shipping_address) is distinct from 'object' then
    raise exception 'Shipping address must be a JSON object' using errcode = '22023';
  end if;

  -- Validate quantities BEFORE aggregating (prevents +10/-5 tricks)
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where (e ->> 'quantity')::int is null
       or (e ->> 'quantity')::int not between 1 and 1000
  ) then
    raise exception 'Invalid quantity' using errcode = '22023';
  end if;

  select id into v_my_seller from public.sellers where owner_id = v_uid;

  -- Ordered by product_id so concurrent orders lock rows in the same order
  for v_item in
    select (e ->> 'product_id')::uuid as product_id,
           sum((e ->> 'quantity')::int) as quantity
    from jsonb_array_elements(p_items) e
    group by 1
    order by 1
  loop
    select p.id, p.seller_id, p.title, p.price_cents, p.currency, p.stock
      into v_product
    from public.products p
    join public.sellers s on s.id = p.seller_id
    where p.id = v_item.product_id
      and p.is_active
      and s.status = 'active'
    for update of p;

    if not found then
      raise exception 'Product % is unavailable', v_item.product_id using errcode = 'P0002';
    end if;

    if v_product.seller_id = v_my_seller then
      raise exception 'You cannot buy your own products' using errcode = '42501';
    end if;

    if v_seller_id is null then
      v_seller_id := v_product.seller_id;
      v_currency  := v_product.currency;
    elsif v_seller_id <> v_product.seller_id then
      raise exception 'All items must come from the same seller' using errcode = '22023';
    elsif v_currency <> v_product.currency then
      raise exception 'All items must use the same currency' using errcode = '22023';
    end if;

    if v_product.stock < v_item.quantity then
      raise exception 'Insufficient stock for "%"', v_product.title using errcode = '23514';
    end if;

    update public.products
    set stock = stock - v_item.quantity
    where id = v_product.id;

    v_total := v_total + v_product.price_cents * v_item.quantity;
    v_lines := v_lines || jsonb_build_object(
      'product_id',       v_product.id,
      'title',            v_product.title,
      'unit_price_cents', v_product.price_cents,
      'quantity',         v_item.quantity
    );
  end loop;

  insert into public.orders (buyer_id, seller_id, status, total_cents, currency, shipping_address)
  values (v_uid, v_seller_id, 'pending', v_total, v_currency, p_shipping_address)
  returning id into v_order_id;

  insert into public.order_items (order_id, product_id, title, unit_price_cents, quantity)
  select v_order_id, x.product_id, x.title, x.unit_price_cents, x.quantity
  from jsonb_to_recordset(v_lines)
    as x(product_id uuid, title text, unit_price_cents bigint, quantity int);

  return v_order_id;
end;
$$;

revoke all on function public.place_order(jsonb, jsonb) from public, anon;
grant execute on function public.place_order(jsonb, jsonb) to authenticated;

-- =====================================================================
-- 7. Privileges (column-level grants restrict WHAT can be written;
--    RLS restricts WHICH ROWS)
-- =====================================================================
revoke all on public.profiles    from anon, authenticated;
revoke all on public.sellers     from anon, authenticated;
revoke all on public.products    from anon, authenticated;
revoke all on public.orders      from anon, authenticated;
revoke all on public.order_items from anon, authenticated;

-- profiles: no insert (trigger does it), no delete (cascades from auth)
grant select on public.profiles to authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;

-- sellers: cannot set status; activation is done by admin/service role
grant select on public.sellers to anon, authenticated;
grant insert (owner_id, store_name, slug, description, logo_url) on public.sellers to authenticated;
grant update (store_name, description, logo_url) on public.sellers to authenticated;

-- products
grant select on public.products to anon, authenticated;
grant insert (seller_id, title, description, price_cents, currency, stock, is_active, images)
  on public.products to authenticated;
grant update (title, description, price_cents, currency, stock, is_active, images)
  on public.products to authenticated;
grant delete on public.products to authenticated;

-- orders: read-only + status updates (guarded by trigger); inserts via place_order()
grant select on public.orders to authenticated;
grant update (status) on public.orders to authenticated;

-- order_items: read-only for clients
grant select on public.order_items to authenticated;

-- =====================================================================
-- 8. Row Level Security
-- =====================================================================
alter table public.profiles    enable row level security;
alter table public.sellers     enable row level security;
alter table public.products    enable row level security;
alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

-- ---- profiles -------------------------------------------------------
create policy "profiles: read own"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles: admin read all"
  on public.profiles for select to authenticated
  using ((select private.is_admin()));

create policy "profiles: update own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ---- sellers --------------------------------------------------------
create policy "sellers: public read active"
  on public.sellers for select to anon, authenticated
  using (status = 'active');

create policy "sellers: owner read own"
  on public.sellers for select to authenticated
  using (owner_id = (select auth.uid()));

create policy "sellers: admin read all"
  on public.sellers for select to authenticated
  using ((select private.is_admin()));

create policy "sellers: create own store"
  on public.sellers for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "sellers: owner update own"
  on public.sellers for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- ---- products -------------------------------------------------------
create policy "products: public read active"
  on public.products for select to anon, authenticated
  using (
    is_active
    and exists (
      select 1 from public.sellers s
      where s.id = products.seller_id and s.status = 'active'
    )
  );

create policy "products: seller read own"
  on public.products for select to authenticated
  using (seller_id = (select private.current_seller_id()));

create policy "products: admin read all"
  on public.products for select to authenticated
  using ((select private.is_admin()));

create policy "products: active seller insert"
  on public.products for insert to authenticated
  with check (seller_id = (select private.current_active_seller_id()));

create policy "products: active seller update"
  on public.products for update to authenticated
  using (seller_id = (select private.current_seller_id()))
  with check (seller_id = (select private.current_active_seller_id()));

create policy "products: seller delete own"
  on public.products for delete to authenticated
  using (seller_id = (select private.current_seller_id()));

-- ---- orders ---------------------------------------------------------
create policy "orders: buyer read own"
  on public.orders for select to authenticated
  using (buyer_id = (select auth.uid()));

create policy "orders: seller read own sales"
  on public.orders for select to authenticated
  using (seller_id = (select private.current_seller_id()));

create policy "orders: admin read all"
  on public.orders for select to authenticated
  using ((select private.is_admin()));

-- Row-level: buyer or seller of that order. Which transitions are allowed
-- is enforced by private.guard_order_update(); only `status` is writable.
create policy "orders: buyer or seller update status"
  on public.orders for update to authenticated
  using (
    buyer_id  = (select auth.uid())
    or seller_id = (select private.current_seller_id())
  )
  with check (
    buyer_id  = (select auth.uid())
    or seller_id = (select private.current_seller_id())
  );

-- (no INSERT/DELETE policies: orders are created via place_order())

-- ---- order_items ----------------------------------------------------
-- Visible iff the parent order is visible (orders RLS applies in the subquery)
create policy "order_items: read via visible order"
  on public.order_items for select to authenticated
  using (
    exists (select 1 from public.orders o where o.id = order_items.order_id)
  );

-- (no write policies: items are created by place_order())
```

## Usage

```ts
// Become a seller (starts as 'pending')
await supabase.from('sellers').insert({
  owner_id: user.id, store_name: 'Acme', slug: 'acme',
})

// Place an order (prices and stock are handled server-side)
const { data: orderId, error } = await supabase.rpc('place_order', {
  p_items: [{ product_id: '…', quantity: 2 }],
  p_shipping_address: { name: 'Jane', line1: '1 Main St', city: 'Paris', country: 'FR' },
})

// Buyer cancels a pending order
await supabase.from('orders').update({ status: 'cancelled' }).eq('id', orderId)

// Seller ships a paid order
await supabase.from('orders').update({ status: 'shipped' }).eq('id', orderId)
```

## Notes

- **Backend-only operations (service role):**
  - Approve sellers: `update sellers set status = 'active'`.
  - Mark orders `paid` or `refunded` and set `payment_intent_id`. Do this in your payment webhook.
  - Grant admin: `auth.admin.updateUserById(id, { app_metadata: { role: 'admin' } })`.
- **Single-seller orders:** `place_order` rejects carts that mix sellers. For a multi-seller cart, call it once per seller, or extend it to loop over sellers and create one order each.
- **Buyer privacy:** sellers can't read `profiles`. They see the buyer's name and address only through the `shipping_address` snapshot on the order.
- **Why column grants plus a trigger:** RLS can't compare `OLD` and `NEW` values. Column grants limit which columns clients can write, and the trigger limits which status transitions are allowed.
- **Test your policies** by impersonating users in SQL:
  ```sql
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<user-uuid>","role":"authenticated"}';
  ```