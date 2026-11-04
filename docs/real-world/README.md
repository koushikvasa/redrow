# Real-world runs, Nov 4 2026

Teammates built apps with AI tools and ran `npx redrow scan` on them. **3 apps scanned; 0 with likely leaks.**

| App | Red Row score | Cross-user/stranger access found | Assessment |
|---|---|---|---|
| [Group Expenses](App_a.html) | 93/A | None found, but there were no other users' rows to try updates and deletes on | needs review |
| [Tutor Bookings](App_C.html) | 58/D | Signed-in user read 1 booking and 3 time slots they don't own | intended sharing |
| [Shared Journal](App_d.html) | 28/F | Signed-in user read 1 journal entry, 1 share and 2 profiles they don't own | needs review |

**The assessment is our judgment of intent, not Red Row's output.** Red Row reports access. We read each app's table names, policy names and counts, not its rows, and called something a likely leak only when the access was clearly unintended from the table's purpose.

- **Group Expenses:** nothing got through, but with no other users' rows in the database, this scan can't show that users are kept apart.
- **Tutor Bookings:** a policy lets tutors see bookings for their own slots, and a booking app needs slots to be browsable.
- **Shared Journal:** the entry fits a policy for shared entries, and there's 1 share to match it. But a policy named `anyone_lookup_by_email` lets a user read other profiles, so someone should check what those hold.

The reports don't record app names, so we named each app from its tables. The AI tool and prompt are not recorded for any of them. `App_b.html` was byte-identical to `App_a.html`, so it counts as one run and is left out. The structured data is in [`apps/web/data/real-world.json`](../../apps/web/data/real-world.json).
