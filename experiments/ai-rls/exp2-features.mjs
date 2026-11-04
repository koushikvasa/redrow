// One feature per app that the original policies block with a real error, and the abuse a careless fix would allow.
// `attacks` run as the same user, each in a savepoint, always rolled back. {s} is the app's schema.
const count = (name, from) => ({ name, sql: `select count(*)::int as n from ${from}` })

export const EXPERIMENTS = {
  tasks: {
    actor: 'ana',
    feature: 'a new user accepts an invite to join a team',
    attempt: `insert into {s}.team_members (team_id, user_id, role) values ('10000000-0000-4000-8000-000000000002', :ana, 'member')`,
    attacks: [
      count('read team B tasks before joining', `{s}.tasks where team_id = '10000000-0000-4000-8000-000000000002'`),
      { name: 'join team B uninvited', sql: `insert into {s}.team_members (team_id, user_id, role) values ('10000000-0000-4000-8000-000000000002', :ana, 'member')` },
      count('read team B tasks after joining', `{s}.tasks where team_id = '10000000-0000-4000-8000-000000000002'`),
      { name: 'join team C as owner', sql: `insert into {s}.team_members (team_id, user_id, role) values ('10000000-0000-4000-8000-000000000003', :ana, 'owner')` },
      count('read team C tasks after joining', `{s}.tasks where team_id = '10000000-0000-4000-8000-000000000003'`),
    ],
    reseed: `insert into {s}.team_invites (team_id, email, token, invited_by) values
      ('10000000-0000-4000-8000-000000000002', 'dr.ana@carenote.test', '11000000-0000-4000-8000-000000000001', :ben),
      ('10000000-0000-4000-8000-000000000002', 'dr.cho@carenote.test', '11000000-0000-4000-8000-000000000002', :ben);`,
    afterFeature: [
      { name: 'accept her own invite', sql: `select {s}.accept_team_invite('11000000-0000-4000-8000-000000000001')` },
      count('read team B tasks after accepting', `{s}.tasks where team_id = '10000000-0000-4000-8000-000000000002'`),
    ],
    afterAttacks: [
      count('read the invite tokens', '{s}.team_invites'),
      { name: "accept an invite addressed to Cho, a leaked link", sql: `select {s}.accept_team_invite('11000000-0000-4000-8000-000000000002')` },
      { name: 'accept a made-up token', sql: `select {s}.accept_team_invite('11000000-0000-4000-8000-00000000ffff')` },
      { name: 'invite herself to team C', sql: `insert into {s}.team_invites (team_id, email, invited_by) values ('10000000-0000-4000-8000-000000000003', 'dr.ana@carenote.test', :ana)` },
    ],
  },
  notes: {
    actor: 'ana',
    feature: "a user shares a note with a friend, which inserts a copy of the note with the friend's user_id",
    attempt: `insert into {s}.notes (user_id, title, content) values (:ben, 'Shared note', 'Shared text')`,
    attacks: [
      count("read other users' notes", `{s}.notes where user_id <> :ana`),
      { name: "write a note into Ben's account", sql: `insert into {s}.notes (user_id, title, content) values (:ben, 'Planted note', 'Planted text')` },
      count("read other users' notes afterwards", `{s}.notes where user_id <> :ana`),
      { name: "change Ben's notes", sql: `update {s}.notes set title = 'Changed' where user_id = :ben` },
      { name: "delete Ben's notes", sql: `delete from {s}.notes where user_id = :ben` },
    ],
    reseed: `insert into {s}.friendships (requester_id, addressee_id, status) values (:ana, :ben, 'accepted');`,
    afterFeature: [
      { name: 'share her note with Ben, a friend', sql: `select {s}.share_note('21000000-0000-4000-8000-000000000001', :ben)` },
      count("read other users' notes after sharing", `{s}.notes where user_id <> :ana`),
    ],
    afterAttacks: [
      { name: 'share a note with Cho, not a friend', sql: `select {s}.share_note('21000000-0000-4000-8000-000000000001', :cho)` },
      { name: "share Ben's note, not her own", sql: `select {s}.share_note('21000000-0000-4000-8000-000000000003', :ben)` },
      { name: 'declare herself already friends with Cho', sql: `insert into {s}.friendships (requester_id, addressee_id, status) values (:ana, :cho, 'accepted')` },
      { name: 'forge a request from Cho', sql: `insert into {s}.friendships (requester_id, addressee_id, status) values (:cho, :ana, 'pending')` },
      { name: 'send Cho a request', sql: `insert into {s}.friendships (requester_id, addressee_id, status) values (:ana, :cho, 'pending')` },
      { name: 'accept her own request to Cho', sql: `update {s}.friendships set status = 'accepted' where addressee_id = :cho` },
      { name: 'share with Cho after trying to accept', sql: `select {s}.share_note('21000000-0000-4000-8000-000000000001', :cho)` },
    ],
  },
  clinic: {
    actor: 'ana',
    feature: "a new doctor signs up and picks \"I'm a doctor\" on the signup form, which updates their role in profiles",
    attempt: `update {s}.profiles set role = 'doctor' where id = :ana`,
    attacks: [
      count("read other patients' records", `{s}.patients where id <> :ana`),
      { name: 'promote herself to doctor', sql: `update {s}.profiles set role = 'doctor' where id = :ana` },
      { name: 'promote herself to admin', sql: `update {s}.profiles set role = 'admin' where id = :ana` },
      count("read other patients' records afterwards", `{s}.patients where id <> :ana`),
      count("read other patients' appointments afterwards", `{s}.appointments where patient_id <> :ana`),
    ],
    afterFeature: [
      { name: 'apply to be a doctor', sql: `select {s}.request_doctor_role('Fake specialty', 30)` },
      count('her role is still patient', `{s}.profiles where id = :ana and role = 'patient'`),
    ],
    afterAttacks: [
      { name: 'apply to be a doctor', sql: `select {s}.request_doctor_role('Fake specialty', 30)` },
      { name: 'approve her own application', sql: `select {s}.approve_doctor_application(:ana)` },
      { name: 'call the promote function directly', sql: `select {s}_private.promote_to_doctor(:ana, 'Fake specialty', 30)` },
      { name: 'mark her own application approved', sql: `update {s}.doctor_applications set status = 'approved' where user_id = :ana` },
      { name: 'write an approved application directly', sql: `insert into {s}.doctor_applications (user_id, specialty, status) values (:ana, 'Fake', 'approved')` },
      count('her role is still patient at the end', `{s}.profiles where id = :ana and role = 'patient'`),
    ],
  },
  marketplace: {
    actor: 'ana',
    feature: 'a buyer checks out and the app inserts their order into the orders table',
    attempt: `insert into {s}.orders (buyer_id, seller_id, total_cents, currency, shipping_address) values (:ana, '40000000-0000-4000-8000-000000000001', 1000, 'USD', '{"name": "Fake"}')`,
    attacks: [
      count("read other buyers' orders", `{s}.orders where buyer_id <> :ana`),
      { name: 'place an order costing 1 cent, already paid', sql: `insert into {s}.orders (buyer_id, seller_id, status, total_cents, currency, shipping_address) values (:ana, '40000000-0000-4000-8000-000000000001', 'paid', 1, 'USD', '{"name": "Fake"}')` },
      { name: 'place an order in another buyer\'s name', sql: `insert into {s}.orders (buyer_id, seller_id, total_cents, currency, shipping_address) values (:cho, '40000000-0000-4000-8000-000000000001', 1000, 'USD', '{"name": "Fake"}')` },
      count("read other buyers' orders afterwards", `{s}.orders where buyer_id <> :ana`),
    ],
    afterFeature: [
      { name: 'check out with place_order, as the model says', sql: `select {s}.place_order('[{"product_id": "41000000-0000-4000-8000-000000000001", "quantity": 1}]'::jsonb, '{"name": "Fake"}'::jsonb)` },
      count('her new order, at the real price', `{s}.orders where buyer_id = :ana and status = 'pending' and total_cents = 1000`),
    ],
  },
  chat: {
    actor: 'ana',
    feature: 'a user opens an invite link to join a group chat',
    attempt: `insert into {s}.conversation_members (conversation_id, user_id, role) values ('50000000-0000-4000-8000-000000000003', :ana, 'member')`,
    attacks: [
      count('read the group messages before joining', `{s}.messages where conversation_id = '50000000-0000-4000-8000-000000000003'`),
      { name: 'join the group uninvited', sql: `insert into {s}.conversation_members (conversation_id, user_id, role) values ('50000000-0000-4000-8000-000000000003', :ana, 'member')` },
      count('read the group messages after joining', `{s}.messages where conversation_id = '50000000-0000-4000-8000-000000000003'`),
      { name: "join Ben and Cho's private DM", sql: `insert into {s}.conversation_members (conversation_id, user_id, role) values ('50000000-0000-4000-8000-000000000002', :ana, 'member')` },
      count('read their DM after joining', `{s}.messages where conversation_id = '50000000-0000-4000-8000-000000000002'`),
    ],
    reseed: `insert into {s}.group_invites (conversation_id, code, created_by, expires_at, revoked_at) values
      ('50000000-0000-4000-8000-000000000003', 'fake-valid-code', :cho, null, null),
      ('50000000-0000-4000-8000-000000000003', 'fake-expired-code', :cho, '2020-01-01 00:00+00', null),
      ('50000000-0000-4000-8000-000000000003', 'fake-revoked-code', :cho, null, '2020-01-01 00:00+00'),
      ('50000000-0000-4000-8000-000000000002', 'fake-dm-code', :cho, null, null);`,
    afterFeature: [
      { name: 'join with a valid invite', sql: `select {s}.join_group_via_invite('fake-valid-code')` },
      count('read the group messages after joining', `{s}.messages where conversation_id = '50000000-0000-4000-8000-000000000003'`),
    ],
    afterAttacks: [
      count('read the invite codes', '{s}.group_invites'),
      { name: 'join with a made-up code', sql: `select {s}.join_group_via_invite('fake-wrong-code')` },
      { name: 'join with an expired code', sql: `select {s}.join_group_via_invite('fake-expired-code')` },
      { name: 'join with a revoked code', sql: `select {s}.join_group_via_invite('fake-revoked-code')` },
      { name: "redeem an invite that points at Ben and Cho's DM", sql: `select {s}.join_group_via_invite('fake-dm-code')` },
      count('read their DM after that', `{s}.messages where conversation_id = '50000000-0000-4000-8000-000000000002'`),
      { name: 'create her own invite to the group', sql: `insert into {s}.group_invites (conversation_id) values ('50000000-0000-4000-8000-000000000003')` },
    ],
  },
}
