# "Next up" is a derived rotation hint on Today, not a schedule

Picked up from the competitor comparison (gap #1, *"which session is today"*), grilled before implementation. [ADR 0007](./0007-minimal-plan-is-degenerate-manual-plan.md) deferred both halves of it on purpose: *binding session selection* (weekday assignment, rotation, scheduling) and *the optional order-derived "next up" hint on Today*. This ADR un-defers the hint and keeps weekday assignment deferred.

## The state before

Today lists the Plan's Prescribed Sessions in authored order, each with Start, and suggests nothing (`Today.tsx`, ADR 0007's *"no auto-select"*). Every workout is a manual pick from the full list, including the common case where the right answer is simply "the one after last time".

## The decision

1. **The selection model is a rotation, not weekdays.** You train the Plan's sessions in order whenever you train, and a missed day shifts nothing. Weekday tags are **not** built: they need a new Plan field and Plan operation, they go stale the first time a day is missed, and a weekday map asserts the weekly cyclicity CONTEXT forbids the Scaffold from assuming. Deferred to a future cyclic Plan model, with a watchlist entry (below) in case daily-driving says otherwise.

2. **Next up = the Prescribed Session after the one your most recently finished workout came from, wrapping from the last back to the first.** Wrapping is what a rotation means in practice. It does *not* make the Plan cyclic: the order is still plain authored data, nothing auto-advances, and only the Today screen reads the list as a loop.
   - **"Most recently finished"** is the newest `finished` Logged Session by `finishedAt`, the same ordering History pages by. `cancelled` workouts don't count. While a workout is `active`, Today shows Resume and no next up ([ADR 0020](./0020-a-workout-in-flight-is-a-server-fact-the-pointer-is-a-hint.md)).
   - **Deleted sessions:** if that workout's Prescribed Session is no longer in the Plan, look further back to the newest finished workout whose session still exists.
   - **Empty sessions are skipped:** a Prescribed Session with no Entries can't be started, so it is never next up; the walk continues past it.
   - **No usable history** (a new Plan, or every past session deleted): next up is the first non-empty session.
   - **Nothing to suggest** (every session is empty): no hero.
   - **Reordering moves it.** Position is read live from the Plan, never stored, so editing the order changes next up immediately.

3. **It renders as a hero above the list, in the Resume slot.** `Next up · <session> · Start`, one tap from opening the app. The full list stays below, unchanged and in authored order, so picking something else is exactly as cheap as before. The hero and Resume are mutually exclusive: an in-flight workout always wins the slot. The hero follows the list's offline rule: when the Plan came from the durable cache, Start is disabled with the same "Offline" treatment as the rows. So that it still renders offline, the client keeps the last answer in device-local storage, like the Resume pointer; Today shows it only while it names a session that is still in the Plan and startable.

4. **Derived on the server, stored nowhere.** Next up is a pure function of the current Plan and the finished Logged Sessions, both already server state. No schema change, no Plan operation, no Change ([ADR 0008](./0008-plan-changes-carry-origin-and-status.md)): nothing is authored.

5. **The coach is not told.** Deliberation's seed is unchanged and carries no notion of rotation or next up. The coach still reads the Plan as an ordered, non-cyclic list, and can pull session order and history from its DB snapshot if a finding needs them ([ADR 0011](./0011-deliberation-internals-run-mechanics.md)). Teaching the coach about cycles belongs to a real cyclic Plan model, not to a Today hint.

## Considered and rejected

- **Fixed weekdays, or weekdays alongside rotation.** Rejected for now (§1). "Both" would also need a rule for when they disagree (it's Wednesday, but Monday's session was skipped), and that rule is a scheduling policy, which is a Plan model's job.
- **Stop at the end of the list instead of wrapping.** Rejected: after the last session the hint would vanish exactly when you need it, and the user would be back to a manual pick on every lap.
- **A per-Plan "rotate" flag.** Rejected: it adds a Plan field and operation to say what the hint already implies, and it starts to turn the Manual model into a scheduling model by the back door.
- **Marking the next-up row in place, or rotating the list to start at next up.** Rejected for the hero: in-place emphasis still needs a scan of the list, and a rotated list breaks the "authored order" reading that the Plan view and Today share.
- **Seeding the coach with the rotation, or recording it as a Standing constraint.** Rejected (§5): either makes the coach reason about a cycle the Plan model does not have.

## Consequences

- ADR 0007's *"What it deliberately leaves for later grilling"* loses the next-up hint; binding selection (weekdays, auto-advance, scheduling) stays deferred.
- The Manual Plan model is unchanged in CONTEXT: the user still picks today's Session. Next up is a suggestion the user accepts by tapping it.
- Weekday tags are deferred on a guess, not on evidence: see [uat-watchlist.md](../design/uat-watchlist.md) entry 16.
- A future cyclic Plan model will own session selection outright. When it arrives, next up becomes that model's answer rather than this derivation, and the hero slot is where it renders.
