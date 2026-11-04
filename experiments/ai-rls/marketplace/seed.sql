-- Fake rows. Ben and Cho run stores, and Ana and Cho buy. Ana has no store.
insert into app_marketplace.profiles (id, display_name) values (:ana, 'Fake Ana'), (:ben, 'Fake Ben'), (:cho, 'Fake Cho');
insert into app_marketplace.sellers (id, owner_id, store_name, slug, status) values
  ('40000000-0000-4000-8000-000000000001', :ben, 'Fake store B', 'fake-b', 'active'),
  ('40000000-0000-4000-8000-000000000002', :cho, 'Fake store C', 'fake-c', 'active');
insert into app_marketplace.products (id, seller_id, title, price_cents, stock) values
  ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'Fake product B1', 1000, 5),
  ('41000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 'Fake product B2', 2000, 5),
  ('41000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', 'Fake product C1', 3000, 5);
insert into app_marketplace.orders (id, buyer_id, seller_id, status, total_cents, currency, shipping_address) values
  ('42000000-0000-4000-8000-000000000001', :ana, '40000000-0000-4000-8000-000000000001', 'paid', 1000, 'USD', '{"name": "Fake A"}'),
  ('42000000-0000-4000-8000-000000000002', :ana, '40000000-0000-4000-8000-000000000002', 'paid', 3000, 'USD', '{"name": "Fake A"}'),
  ('42000000-0000-4000-8000-000000000003', :cho, '40000000-0000-4000-8000-000000000001', 'paid', 2000, 'USD', '{"name": "Fake C"}');
insert into app_marketplace.order_items (order_id, product_id, title, unit_price_cents, quantity) values
  ('42000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 'Fake product B1', 1000, 1),
  ('42000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000003', 'Fake product C1', 3000, 1),
  ('42000000-0000-4000-8000-000000000003', '41000000-0000-4000-8000-000000000002', 'Fake product B2', 2000, 1);
