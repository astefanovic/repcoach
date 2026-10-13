# A swap is an Entry-level actual-side annotation, offered only before the Entry has a logged Set

Issue #131, item 4 of #115's scope-control clause (unplanned straight set → continuations (#129) → note (#130) → swap). The hint on `SPECIALS`' `swap` entry states the requirement: a swap **keeps the link back to the prescribed slot** — the coach must be able to tell *"did DB press instead of the prescribed barbell press"* from *"the plan says DB press"*, because the substitution itself is evidence (equipment busy, a cranky shoulder, a different gym).

## The load-bearing question, answered

**Does a swap extend the frozen prescription copy, or live as an actual-side annotation?** ADR 0017 asked the same shape of question for an unplanned Set and answered *actual-side, extending nothing* — but ADR 0017 explicitly named swap as **not covered** by its own reasoning, and for a real reason: an unplanned Set adds a new node; a swap changes what an *existing* node's exercise identity resolves to, and the prescribed exercise must stay legible afterwards. Extending the frozen copy in place — overwriting `entry.exerciseId` in the Logged Session's `snapshot_json` — is exactly what "extending" would mean here, and it is disqualified on inspection: `snapshot_json` is the one thing this codebase guarantees never changes after `startSession` (ADR 0006/0007's copy-on-instantiate rule), and overwriting it would destroy the prescribed side the whole feature exists to keep.

So the answer is **actual-side annotation** — but not shaped like `logSetActual`. A `LogSetActualResult` is a new row keyed by a fresh `setId`; there is no equivalent "fresh id" for an Entry whose exercise changed, because the Entry itself did not change identity, only what it *names* going forward. The natural unit is a second small fact, anchored to the Entry the way a Set's actual is anchored to a Set: `SwapEntryExerciseResult { commandId, loggedSessionId, entryId, exerciseId, swappedAt }`, read back alongside `session`/`actuals` on `getLoggedSession` as a third array, `swaps`. `entry.exerciseId` inside the frozen `session` tree is the prescribed exercise, forever; a `swaps` entry naming that `entryId` is the performed one. Both are visible in the same read, which is what "swap-provenance is free" (ADR 0007's own words, describing exactly this Entry) turns out to mean in practice: the frozen copy already retains the prescribed side, so the only new fact worth recording is the actual side.

This reuses ADR 0017's real insight even though its literal conclusion doesn't transfer: `logSetActual` carries `entryId`/`setId` **by value**, with no FK or lookup against the prescribed tree, and that same by-value carrying is what makes `swapEntryExercise` safe to add as a sibling write rather than a schema migration of the Scaffold. Neither command needs to know the prescribed tree exists; both just say what happened, keyed by the ids the tree handed out at `startSession`.

## What happens to already-logged Sets

Three shapes were on the table:

- **Offered only before any Set on the Entry is logged.** Simplest, and the affordance disappearing after the first ✓ is self-explaining — nobody discovers "wrong gym, wrong rack" after set 2 of 4 without also noticing after set 1.
- **Swap splits the Entry** — logged Sets stay against the old exercise, later ones against the new. Most truthful in the case where a genuine mid-workout swap happens after some work is done, but it needs a second Entry (or a per-Set exercise override) that nothing else in the Scaffold has, plus rendering rules for a "half-swapped" Entry, plus a new question for the coach's read side: does a stall/volume computation for one Entry now span two exercise identities?
- **Logged Sets move to the new exercise.** Rejected outright — it silently rewrites a record the app already has, which is the one thing ADR 0006 exists to prevent logging from ever doing to itself, let alone to the Plan.

**Chosen: offered only before any Set on the Entry is logged**, enforced on both sides — the client hides the affordance once `model.actuals` names the Entry (`Logging.canSwapEntry`, the same `entryId`-bucketing ADR 0017 introduced for orphan reconstruction), and the server refuses with a typed `EntryAlreadyLoggedError` if a queued swap reaches it after a Set won the race (mirroring `cancelSession`'s belt-and-suspenders pattern — `Grid.canCancelSession` client-side, `LoggedSessionHasActualsError` server-side, for the identical shape of race: an offline queue can reorder what the user's taps suggested happened in order).

This is the cheapest defensible option, and cheap here means something specific: it needs no new Scaffold node, no per-Set exercise override, and no new question for Session review's per-Entry volume/stall reasoning, because an Entry that has been swapped and then logged into is, from that point on, indistinguishable in shape from an Entry that was *always* prescribed the swapped exercise except for one extra fact sitting beside it. Read back months later, the coach sees: this Entry named Barbell Bench Press; the user swapped it to DB Bench Press at 14:32 before logging anything; every logged Set is DB Bench Press. Nothing is split, nothing is joined, nothing needs reconciling.

The Entry-split option is not wrong, only more expensive for a case (swapping mid-Entry, after partial logging) the ticket itself frames as the harder, not-yet-motivated branch — genuine "I hurt myself on rep 3 of set 2, finishing on machine" swaps exist, but they are rare enough, and distinguishable enough from ordinary equipment-availability swaps, that building for them now would be building for a usage pattern nobody has observed yet. That is a **uat-watchlist** question, not a launch blocker — see this ADR's Consequences.

## The catalog picker

The swapped-to exercise is picked from `Plan.tsx`'s `ExercisePicker` — the same component the Plan editor uses, now exported so `Logging.tsx` can render it with a different wiring: `onPick` calls `swapExercise` instead of `editor.apply({_tag: "addEntry", ...})`, and `onCreate` still goes through the existing `createExercise` RPC unchanged (ADR 0016 — a catalog row is not part of the Plan, so minting one here mints no Change either, exactly as it doesn't from the Plan editor). `CatalogAuthoring` (create/rename/offline) is unchanged; `LogSurface` builds one from `useExerciseCatalog` and `useConnectionState`, the same two hooks `PlanRoute` already uses. A swap can therefore name a user-authored exercise (ADR 0016) with no new machinery — reuse, not a second picker, is the whole point of naming this in the ticket.

## Offline

`swapExercise` is its own outbox command kind (`OUTBOX_SCHEMA_VERSION` 4 → 5), queued and flushed exactly like `applyPlanEdit` — including the **reject, not remove** distinction on a permanent server refusal (`EntryAlreadyLoggedError`), because a rejected swap is showing on screen and only a rejection tells the user to stop trusting it. Picking an **existing** catalog exercise to swap to works fully offline, the same way picking an existing exercise in the Plan editor does. Creating a **new** user-authored exercise to swap to does not — `ExercisePicker`'s existing `authoring.offline` guard (disabled row, visible reason) covers this identically to the Plan editor, because `createExercise` was never brought inside the outbox (ADR 0016 §4) and this ADR does not change that.

## Rendering: typography, not a new card

Per #115's constraint, a swapped Entry renders in the existing grid. The performed exercise (what the coach needs to read first — it is what actually happened) takes the `EntrySection` title position; when a swap exists for the Entry, a small faint line underneath reads `swapped from <prescribed name>` — the same visual register `SetRow` already uses for "queued" and the deviation labels, not a new card, wrapper, or colour. The prescribed name is never hidden and never overwritten; it is one line of context, exactly as the ticket asked for.

## Never touches the Plan

`swapEntryExercise` writes only `logged_entry_swap` (SQLite) / `entrySwapsByCommandId` (in-memory) — a table anchored to `logged_session_id`, disjoint from every Plan table (`prescribed_session`/`block`/`entry`/`prescribed_set`) and from the frozen `snapshot_json` a Logged Session carries. There is no code path from a swap into `applyUserPlanChange`'s operation union or the Decision log. The footer text `never touches the plan` stays true by construction: nothing this ADR adds can reach a `plan_id`.

## Idempotency

`commandId`-keyed, mirroring `logSetActual`/`addContextNote`: `INSERT ... ON CONFLICT(command_id) DO NOTHING` followed by a read-back by `commandId`, so a replayed outbox item (reconnect after a partial ack) returns the exact row the first attempt wrote rather than erroring or minting a second swap. Because the already-logged-Set guard is checked before the insert on a **fresh** commandId only — a replay of a commandId that already landed is resolved without re-checking, so a swap that legitimately landed before any Set was logged is never retroactively un-done by a later Set arriving out of order in a replay storm.

## Considered and rejected

- **A `LoggedEntry` type carrying its own actual `exerciseId`, widening the Scaffold.** Rejected: it would make every Entry-reading path (rendering, catalog joins, per-Entry volume) branch on prescribed-vs-swapped identity structurally, for a fact that is true of maybe one Entry in a whole Session. A sibling `swaps` array keeps the common case (no swap) exactly as cheap as it is today.
- **A per-Set exercise override, piggybacked on `logSetActual`'s `actual` map.** Rejected: it would only ever be written once per Entry under this ADR's own already-logged-Sets rule (no Set exists yet to attach an override to), so per-Set storage would carry a per-Entry fact redundantly on every future Set, and reconstructing "was this Entry swapped" would mean scanning every actual instead of reading one row.
- **Requiring the swap to go through a Deliberation Proposal ("propose swapping this Entry") instead of a direct write.** Rejected on ADR 0006's own terms: logging captures what happened, it does not ask permission to record a fact. A swap is not a Plan edit and never becomes one from inside a workout — see "never touches the Plan" above.

## Consequences

- `LoggedSession.swaps: ReadonlyArray<SwapEntryExerciseResult>` is a new field on the `getLoggedSession` read; a Logged Session with no swap returns an empty array, so every existing reader that ignores unknown fields is unaffected.
- Migration `018` adds `logged_entry_swap`, following `017`'s `logged_session.review_status` as the most recent precedent for a small, purpose-built table rather than widening an existing one.
- `SPECIALS`' `swap` entry loses `wired: false`. `drop`/`rest-pause`/`myo-cluster`/`note` do not — those are #129 and #130's scope (open PRs #135/#136 at the time of this ADR, not yet merged to the branch this work is based on), and wiring them is out of this ticket's boundary regardless of their nominal ordering in #115's scope-control clause. `SPECIALS`' `wired` flag and the sheet's "· not yet wired" hint machinery therefore stay, contrary to the ticket's closing line ("SPECIALS should have no wired: false entries left") — that line assumed #129/#130 would already be merged by the time #131 landed, which was not true of the branch this work started from.
- **Uat-watchlist #11**: whether "offered only before any Set is logged" is too restrictive in practice — a real mid-workout equipment failure after set 2 currently has no swap affordance at all. See `docs/design/uat-watchlist.md` #11 for the observable signals and the two pre-planned fallbacks (split the Entry; widen the unplanned-Set escape hatch). If it bites, the Entry-split option above is the fallback, not a redesign — the model this ADR chose (Entry-scoped `swaps`, by-value ids, no Scaffold widening) does not need to change, only the already-logged-Sets rule does.

## Amendment (2026-10-08, UAT): an exercise added mid-workout is a swap on a new Entry

Daily use asked for a way to add an exercise to a workout already in progress. The model above already has one, so nothing new was added to the contract or the schema:

- The client mints a fresh `EntryId` and sends `swapEntryExercise` naming the chosen exercise. The server never checked that a swap's `entryId` exists in the frozen snapshot, and the already-logged guard passes trivially for an Entry with no Sets.
- Sets on it are logged by value against that `entryId`, as ADR 0017 does for an unplanned Set. Its row ids are derived from the Entry id (`<entryId>:1..3`), so the rows rebuilt after a reload are the ones the actuals name.
- The Logging surface rebuilds the Entry from `swaps` on every render (`withAddedEntries`): a swap whose `entryId` the snapshot does not hold is an added exercise, shown after the plan's Entries with "added this workout" where a swapped Entry says "swapped from".
- The coach needs no change. `logged_set_net` (migration `024`) already reads such a Set with `prescribed_exercise_id` NULL and `exercise_id` from the swap, which is the truth: performed, never prescribed.

It goes through the outbox like any swap, so adding an exercise already in the catalog works offline. Creating a new name needs the server, as it does for a swap. There is no way to take an added exercise back; one with no logged Sets is an empty Entry the coach never sees, since `logged_set_net` lists only logged Sets.

## Amendment (2026-10-13, UAT): finishing offers to carry a swap into the Plan

The owner kept making the same swap workout after workout (the seated leg curl Entry was swapped on 2026-10-05 and again on 2026-10-12), and each time the Plan went on prescribing the exercise they no longer did. So finishing a workout now asks.

- After `finishWorkout` succeeds, the Logging surface lists every swap on an Entry the Plan **still prescribes exactly as this workout froze it** (`planSwapCandidates`) in an "Update the plan?" sheet, one row per swap, `<prescribed> → <performed>`. Close keeps the Plan unchanged and goes to Today. A workout with no such swap goes straight to Today, as before.
- Skipped: an exercise added mid-workout (no prescribed Entry to replace), a swap back to the prescribed exercise, and an Entry the Plan has removed or re-pointed since the workout started. Offering those would overwrite an edit made after the workout began.
- Tapping a row sends one new Plan operation, `setEntryExercise { entryId, exerciseId }`, through the outbox like any Plan-screen edit. It is a user-direct Change, auto-applied (ADR 0008), and it keeps the Entry's id, position and Sets. The Entry's `trackedMetrics` follow the new catalog row, the way `addEntry`'s do. `removeEntry` + `addEntry` would have minted several Changes for one decision, changed the Entry id, and dropped the Sets, so this is a new member of ADR 0015's closed set rather than a composition of existing members. Its inverse is the same operation naming the previous exercise.
- This does not reopen the "never touches the Plan" rule above. The swap still writes only `logged_entry_swap`. The Plan changes only when the user answers a separate question after the workout is over.
