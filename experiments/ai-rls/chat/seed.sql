-- Fake rows. Ana and Ben share a DM, Ben and Cho share a DM, and Cho owns a group with Ben. Ana and Cho share nothing.
insert into app_chat.profiles (id, username, display_name) values
  (:ana, 'fake_ana', 'Fake Ana'), (:ben, 'fake_ben', 'Fake Ben'), (:cho, 'fake_cho', 'Fake Cho');
insert into app_chat.conversations (id, type, title, dm_key, created_by) values
  ('50000000-0000-4000-8000-000000000001', 'direct', null, 'fake-dm-ana-ben', :ana),
  ('50000000-0000-4000-8000-000000000002', 'direct', null, 'fake-dm-ben-cho', :ben),
  ('50000000-0000-4000-8000-000000000003', 'group', 'Fake group', null, :cho);
insert into app_chat.conversation_members (conversation_id, user_id, role) values
  ('50000000-0000-4000-8000-000000000001', :ana, 'member'),
  ('50000000-0000-4000-8000-000000000001', :ben, 'member'),
  ('50000000-0000-4000-8000-000000000002', :ben, 'member'),
  ('50000000-0000-4000-8000-000000000002', :cho, 'member'),
  ('50000000-0000-4000-8000-000000000003', :cho, 'owner'),
  ('50000000-0000-4000-8000-000000000003', :ben, 'member');
insert into app_chat.messages (conversation_id, sender_id, body) values
  ('50000000-0000-4000-8000-000000000001', :ana, 'Fake message'),
  ('50000000-0000-4000-8000-000000000001', :ben, 'Fake message'),
  ('50000000-0000-4000-8000-000000000002', :ben, 'Fake message'),
  ('50000000-0000-4000-8000-000000000002', :cho, 'Fake message'),
  ('50000000-0000-4000-8000-000000000003', :cho, 'Fake message'),
  ('50000000-0000-4000-8000-000000000003', :ben, 'Fake message');
