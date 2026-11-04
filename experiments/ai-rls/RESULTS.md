# Does AI-written RLS leak?

**In this run, no.** We asked Claude Sonnet 5.5 for five Supabase schemas with no security hints, and attacked each as three different users. Red Row proved no cross-user leak in any of them.

This is one model, one call per app, on Nov 4, 2026. It doesn't show that AI-written RLS is safe in general.

## Results

Scores are raw Red Row output from the full scan, by attacker. "Reviewed leaks" is our reading of each row that got through, checked against who the seed data and the model's own stated rules say should see it.

| App | Red Row score | Rows that got through | Reviewed leaks | Advisor flagged? |
|---|---|---|---|---|
| Team task manager | 99/A, all three attackers | 0 | **0** | Hosted: can't see it. Linter: nothing in security |
| Personal notes | 100/A, all three attackers | 0 | **0** | Hosted: can't see it. Linter: nothing in security |
| Clinic appointments | Patients 45/D, doctor 0/F | Patient: 1 doctor directory row, 1 doctor profile. Doctor: 4 appointments, 2 patients, 2 profiles read, 2 appointments updated | **0** | Hosted: can't see it. Linter: 1 `SECURITY DEFINER` function |
| Marketplace | Buyer 46/D, sellers 21/F | Stranger: 3 products, 2 stores. Sellers: 2 and 1 orders read, the orders placed with their own store | **0** | Hosted: can't see it. Linter: 1 `SECURITY DEFINER` function |
| Private chat | 0/F, all three attackers | Up to 3 messages, 3 member rows, 2 conversations, 2 profiles read, 1 member removed | **0** | Hosted: can't see it. Linter: 7 `SECURITY DEFINER` functions |

**The low scores aren't leaks, and that's a limit of Red Row.** It proves who can reach which rows. It can't tell a leak from sharing the app intends, so a doctor reading their own patient scores the same as a stranger reading it. Chat is 0/F because members of a conversation can read each other's messages, which is the point of chat.

## What got through, and why we don't call it a leak

Every count matches the seed exactly, with no extra rows. Each user's other rows stayed blocked.

| What got through | Why it's intended | What stayed blocked |
|---|---|---|
| Chat: Ana reads 1 message | Ben's message in the DM they share | The other 4 messages, in conversations she isn't in |
| Chat: Ben reads 3 messages | The others' messages in conversations he's in | |
| Chat: Cho removes 1 member | She owns the group, and policy lets owners remove plain members | |
| Clinic: Ben reads 4 appointments, updates 2 | He is the doctor on all of them, and a trigger limits which fields he can change | |
| Clinic: Ana reads 1 doctor profile and 1 directory row | The policy is named as a directory of doctors | Cho's appointments and patient record |
| Marketplace: Ben reads 2 orders, Cho reads 1 | Orders placed with their own store | Ana, a buyer, reads no one else's order |
| Marketplace: a stranger reads 3 products, 2 stores | The storefront, in policies named "public read active" | Orders, profiles and order items |
| Chat: everyone reads 2 profiles | The model's notes say this is for user search, and to keep private data out of the table | |

## The nearest thing to a leaky policy

We found no leaky policy, so here's the closest. It shows what Red Row proves, and where a person has to decide.

```sql
create policy "profiles: read by authenticated"
  on public.profiles for select to authenticated
  using (true);
```

**The attack:** sign in as Ana and select other users' profiles. Red Row counts 2 rows, and the transaction rolls back. The linter doesn't flag this `using (true)`, because its always-true check skips SELECT policies. It would be a real leak on a table holding private data. Here the model says the table holds none, and that this is what user search needs.

## Method

**The prompt**, one fresh call per app, with no system prompt:

```text
Generate the Supabase Postgres schema with RLS policies for: <app>. Users sign in with Supabase Auth.
```

**Model:** `claude-sonnet-5-5`, from `REDROW_MODEL`, with no fallback model. All five calls ended with `end_turn`. Each app's folder holds `prompt.txt`, the raw `output.md` and `meta.json`. The task manager's description, from the brief, includes "see only their team's tasks", so it had one requirement stated that the others didn't.

**Applying it.** All five applied without errors, one at a time, into their own schema in the `carenote-demo` project. We ran the first SQL block of each output, as [`rewritten.sql`](tasks/rewritten.sql) shows. Only schema names changed: `public` to `app_tasks` and so on, and `private` to `app_tasks_private`. Three things in the harness made that a fair test:

- **Default grants.** Supabase gives API roles access to `public` automatically, and a new schema gets none, which would have made every attack falsely denied. [`run.mjs`](run.mjs) grants a new schema the same access first.
- **One app at a time.** All five create the same trigger name on `auth.users`, so each was applied, scanned and dropped before the next.
- **Extensions.** The clinic app's `create extension btree_gist` was pointed at its own schema, so it couldn't land in `public`.

**Seeding.** Each app got fake rows in its [`seed.sql`](tasks/seed.sql), written by service role and owned by three existing `@carenote.test` users.

**Attacking.** Red Row ran read-only and then fully, with each of the three users as attacker, every attack rolled back. Results are in each app's `results.json`. We set `ownerColumns` where Red Row couldn't detect the owner itself, as in `messages.sender_id` ([`apps.mjs`](apps.mjs)).

## The Advisor can't see these schemas

**Hosted Advisor.** `supabase db advisors --remote` returned the same 6 CareNote lints with every app applied, and nothing from the app schemas. Its checks are limited to schemas exposed through the API, and these aren't, so that silence isn't a miss.

**So we also ran its linter.** We ran [splinter](https://github.com/supabase/splinter) (commit `fccca4b`), the open-source linter we understand backs the Advisor, in a read-only transaction with each schema marked as exposed.

**The control.** On CareNote's `public` schema the linter flags `profiles`, `patient_summary`, `search_patients` and the permissive insert on `appointments`. It doesn't flag `patients` SELECT `using (true)` or `visit_notes` DELETE. That matches the [dashboard comparison](../../README.md#craft). The CLI's hosted result didn't include the permissive insert, so the two routes differ on that one lint.

**What it found.** The security lints on the apps were all `SECURITY DEFINER` functions callable by signed-in users, such as `place_order` and `create_direct_conversation`. The model wrote these as the deliberate way to do those writes. Two in chat are trigger functions, which can't be called directly. Other lints, such as unindexed foreign keys and multiple permissive policies, are about performance.

## What this doesn't show

- **Five samples from one model.** The result could differ with another model, an app builder's own prompt, or another run.
- **Functions weren't attacked.** Red Row probes tables. The RPCs and helper functions were read, not exploited. `create_group_conversation`, for instance, can add any user to a group, and that's not something these probes test.
- **Only three users.** With one doctor, a doctor reaching another doctor's patients wasn't tested. In the task manager each user was alone in a team, so teammates weren't tested either.
- **Our review is a judgment.** The raw numbers are in `results.json` so you can check it.

## Cleanup

Each app's schemas were dropped after its scan. [Snapshots](snapshots/before.json) of CareNote taken before and after are byte-identical: `public` tables, row counts, columns, policies, functions, triggers and grants, plus triggers on `auth.users`, extensions and realtime tables. The dashboard still showed CareNote at 0/F with 23 findings afterwards. Nothing was uploaded to HQ.
