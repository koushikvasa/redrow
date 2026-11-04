-- Fake rows. Each user is alone in their own team, so any cross-user access is a real cross-team leak.
insert into app_tasks.profiles (id, display_name) values (:ana, 'Fake Ana'), (:ben, 'Fake Ben'), (:cho, 'Fake Cho');
insert into app_tasks.teams (id, name, created_by) values
  ('10000000-0000-4000-8000-000000000001', 'Fake team A', :ana),
  ('10000000-0000-4000-8000-000000000002', 'Fake team B', :ben),
  ('10000000-0000-4000-8000-000000000003', 'Fake team C', :cho);
insert into app_tasks.tasks (team_id, title, created_by, assigned_to) values
  ('10000000-0000-4000-8000-000000000001', 'Fake task A1', :ana, :ana),
  ('10000000-0000-4000-8000-000000000001', 'Fake task A2', :ana, :ana),
  ('10000000-0000-4000-8000-000000000002', 'Fake task B1', :ben, :ben),
  ('10000000-0000-4000-8000-000000000002', 'Fake task B2', :ben, :ben),
  ('10000000-0000-4000-8000-000000000003', 'Fake task C1', :cho, :cho),
  ('10000000-0000-4000-8000-000000000003', 'Fake task C2', :cho, :cho);
