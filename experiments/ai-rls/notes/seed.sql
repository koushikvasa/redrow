-- Fake rows owned by three different users.
insert into app_notes.profiles (id, display_name) values (:ana, 'Fake Ana'), (:ben, 'Fake Ben'), (:cho, 'Fake Cho');
insert into app_notes.folders (id, user_id, name) values
  ('20000000-0000-4000-8000-000000000001', :ana, 'Fake folder A'),
  ('20000000-0000-4000-8000-000000000002', :ben, 'Fake folder B'),
  ('20000000-0000-4000-8000-000000000003', :cho, 'Fake folder C');
insert into app_notes.notes (id, user_id, folder_id, title, content) values
  ('21000000-0000-4000-8000-000000000001', :ana, '20000000-0000-4000-8000-000000000001', 'Fake note A1', 'Fake text'),
  ('21000000-0000-4000-8000-000000000002', :ana, '20000000-0000-4000-8000-000000000001', 'Fake note A2', 'Fake text'),
  ('21000000-0000-4000-8000-000000000003', :ben, '20000000-0000-4000-8000-000000000002', 'Fake note B1', 'Fake text'),
  ('21000000-0000-4000-8000-000000000004', :ben, '20000000-0000-4000-8000-000000000002', 'Fake note B2', 'Fake text'),
  ('21000000-0000-4000-8000-000000000005', :cho, '20000000-0000-4000-8000-000000000003', 'Fake note C1', 'Fake text');
insert into app_notes.tags (id, user_id, name) values
  ('22000000-0000-4000-8000-000000000001', :ana, 'fake-a'),
  ('22000000-0000-4000-8000-000000000002', :ben, 'fake-b'),
  ('22000000-0000-4000-8000-000000000003', :cho, 'fake-c');
insert into app_notes.note_tags (note_id, tag_id, user_id) values
  ('21000000-0000-4000-8000-000000000001', '22000000-0000-4000-8000-000000000001', :ana),
  ('21000000-0000-4000-8000-000000000003', '22000000-0000-4000-8000-000000000002', :ben),
  ('21000000-0000-4000-8000-000000000005', '22000000-0000-4000-8000-000000000003', :cho);
