# One-tap ✓ seeds an unprescribed metric — from the last Set, then from the last time the Exercise was performed

Issue #149, from UAT: *"get weights and reps from last use of exercise or from last set — i.e. don't keep it blank when hitting tick."*

## The behaviour before

`resolveGhostActual` (`packages/client-runtime/src/logging/grid.ts`) is what one tap on ✓ writes. It filled a metric only when the prescribed interval carried a bound (`interval.max ?? interval.min`). A metric the prescription left open — `{}`, rendered as "report" / "report effort" — resolved to **nothing**, so ✓ committed an actual with that metric simply absent. The field was on screen, the user tapped the one control the row offered, and the number they lifted was not recorded.

`seedFromPreviousSet` (same file, #113 item 4) already seeded the **editor's opening value** from the most recent actual for that metric on an earlier Set of the same Entry. Its doc named two boundaries this ADR changes:

- *"This logged Session only. The cross-session question ('what did I lift last week') is a history read"* — and no such read existed.
- *"A seed, not a ghost … the row still renders `–` … one tap on ✓ still must not write a load nobody prescribed."*

## The decision

**(a): ✓ writes the seeded value, and the row shows it before the tap.** The UAT report asks for exactly this; option (b) — keep opening the editor at the seed, keep rendering `–` — is cheaper but leaves the complaint standing.

Two tiers, tier 1 winning, both funnelled through one function (`seedUnprescribedMetric`) so there is no second seeding path:

1. **`seedFromPreviousSet`** — the most recent actual for this metric on an earlier Set of this Entry, this session. Pure, offline, no RPC. Unchanged from #113.
2. **`lastActualForExercise`** — a new bounded RPC: the most recent actual per metric the last time this **Exercise** was performed, across *finished* Logged Sessions. Falls back to nothing when offline.

`oneTapActual` composes them: the prescribed resolution for every bounded metric, plus a seed for every rendered metric the prescription leaves open. **The prescription always wins** — a seed only ever fills a metric `resolveGhostActual` left absent. A metric with neither a bound nor a seed stays absent; ✓ never invents a number for it.

### Why the RPC is drawn narrow

`LastActualForExerciseInput { exerciseId }` → `LastActualForExerciseResult { exerciseId, perMetric: ActualMetricMap }`. One value per metric, no dates, no per-Set breakdown, no error channel. It is a seed source, not a history query, and the acceptance criteria say so explicitly ("this must not grow into a general history query"). The resolution rule lives once, in `resolveLastActualForExercise` (`@repcoach/persistence`), fed by both `Store` layers:

- **Swap-aware (ADR 0019).** Keyed on the exercise an Entry was *performed* against — its most recent recorded swap, or its frozen prescribed `exerciseId`. A prescribed squat performed as a leg press contributes to the leg press's history. Getting this backwards would seed a squat load onto a leg press.
- **Net state (ADR 0019).** The log/retraction stream is folded first, so a mis-tapped log-then-retract seeds nothing.
- **Newest wins.** Sessions newest-first by `finishedAt`; within a session, later-applied Sets read first (input order — same-millisecond logs make `appliedAt` an unsafe tiebreaker). First value seen per metric is kept.
- **Catalog-bounded.** Only the Exercise's `trackedMetrics` (CONTEXT `Exercise catalog`) appear.
- **Finished sessions only.** An in-flight session's own earlier Sets are tier 1's job; this is the across-session read tier 1 always named and never had.

## Rendering: `~N`, italic — typography, not a new card

Per #113's constraint (a logging row must still read as a logging row), the seed reuses the existing register rather than inventing a colour or a card. An unprescribed metric that has a seed renders the seed as **`~N` in italic `text-text-ghost`** — the tilde and the slant say "from last time", distinct at a glance from an upright prescribed ghost (`8-10`, `<=8 RPE`) and from a genuinely seedless `–`. A sub-line reads `✓ logs N · last time`, the same faint hint `showsResolution` already uses for a range. The accessible name says `seeded N from last time`. Only a metric with no seed at all still shows `–`.

## Offline

Tier 1 is a pure derivation over Sets already on screen and works offline unchanged. Tier 2 is a server read with **no local cache in this iteration** — `useLastExerciseActuals` fires the RPC fire-and-forget, and on any failure (offline, dead socket, slow server) returns `undefined`; the row falls back to tier 1 or `–`. An honest absence, never a hang: nothing on the Logging surface awaits it. Whether a cold offline start deserves a durable last-use cache (the prescription cache is the precedent) is a **uat-watchlist** question — see Consequences.

## Never authors prescription

A seed is an actual-side convenience, exactly like `logSetActual`. It never writes to the Plan, mints a Change, or alters the frozen prescription copy (ADR 0006/0007). The only new persisted concept is a read; nothing new is written.

## Consequences

- A one-tap ✓ on an unprescribed-load exercise now records the load carried over from the last Set / last session, instead of a blank. The number is visible before the tap, so the tap stays honest about what it writes.
- New RPC `logging.lastActualForExercise`, handled on both `Store` layers via one shared resolver. It is deliberately un-paginated and un-dated; a genuine history surface (#114 Part 2's `listSessions` is the existing one) is where that belongs.
- **uat-watchlist #14** — tier 2 is online-only. Watch whether a cold offline start that shows `–` (or a stale tier-1 value) for a load the user has lifted for months is a real annoyance, and if so, add the durable cache.
- No change to ADR 0019: this aligns one-tap ✓ with the swap-aware, net-state rules ADR 0019 already documents, rather than adding to them.

## Amendment (2026-09-26, UAT): ✓ repeats the previous Set over the prescription

"The prescription always wins" did not survive daily use. After logging 62.5kg × 9 against "60kg × 8-10", tapping ✓ on the next Set wrote 60 × 10 again, so every Set after an adjustment cost the same edits twice. What the user wanted from ✓ was "same as the last set".

`carryForwardPrescribedMetric` (`grid.ts`) now outranks `resolveGhostActual` in `oneTapActual`: for a **prescribed** metric, ✓ writes the actual from the nearest earlier Set of this Entry, this session. It only carries between Sets that were prescribed alike, so a deliberate change in the prescription still wins:

- **Same Set type.** A warmup never sets a working Set's numbers, and a drop set never sets a straight set's.
- **Same target for that metric.** A ramp or a pyramid prescribes a different number per Set on purpose, so there the plan's number stands.
- **Never RPE.** Effort is reported after the fact, not repeated.

Unprescribed metrics keep the two-tier seed above, unchanged. On the row, the prescribed ghost stays visible and the hint under it reads `✓ logs N · last set`. The stepper opens at the carried value, so ✓ never writes a number the row did not show before the tap. Like the seed, this is an actual-side convenience: it never writes to the Plan.

## Amendment (2026-10-08, UAT): last time, Set by Set, over the plan's range

The range lost too. Daily use asked for each row to suggest what was lifted last time for that exercise, and to fall back to the range only for an exercise never done before.

- **Set by Set, not per metric.** `lastActualForExercise` now also returns `sets`: the last finished session that performed the Exercise, in the order its Sets sat on the Entry (snapshot order, then Sets the snapshot never held, in log order). A row reads its counterpart by position within its Set type (`Logging.lastTimeActual`): working Set 2 reads last time's working Set 2, and Sets past the end repeat the last one of that type. One value per metric would have suggested the tired final Set, or a drop set's load, for every row.
- **`suggestMetric` decides between last time and the previous Set.** While the user logs exactly last time's numbers, each Set keeps its own history, so a 10-9-8 descent is suggested as 10-9-8. Once a Set departs from its last-time value, the departure carries forward, which is the 2026-09-26 amendment's rule. With no history the previous amendment applies unchanged.
- **It outranks the prescription, ranges and exact targets alike, unless the plan moved.** Each Set in `sets` carries the target it was prescribed that day (`target`, from the frozen snapshot). Where today's target for a metric differs from that one, the plan changed on purpose (an accepted Proposal raising the load, or the user's own edit), so the row shows the plan's number for that metric and ✓ writes it. Metrics the change did not touch keep last time's. A Set the snapshot never held has no target and always keeps its history. Without this, an accepted +2.5 kg Proposal was hidden behind last time's load until the user typed the new one.
- **No hint line.** The row now shows what ✓ writes, so the `✓ logs N · …` sub-line under each value is gone. The range shows only when there is nothing to suggest, and ✓ then writes its top, as before. `~N` italic stays the register for a metric the plan leaves open.
- **The read retries on reconnect.** `useLastExerciseActuals` re-fires when the RPC session comes up. Before, a surface that mounted before the socket connected (every reload) never got its history.

`resolveLastActualForExercise` also stopped ignoring Sets the snapshot does not hold. An unplanned Set (ADR 0017) and an exercise added mid-workout (ADR 0019's 2026-10-08 amendment) are matched through the row's own `entryId` and that Entry's performed exercise.
