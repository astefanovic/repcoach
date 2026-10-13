# User-authored exercises are name-only rows the coach silently enriches

The Exercise catalog (CONTEXT) is described as *coach-authored*: production starts with it **empty** and Intake authors its first rows when a drafted Plan is accepted ([#75](https://github.com/astefanovic/repcoach/issues/75)). The user needs to add arbitrary exercises to the Plan, and therefore to the catalog, outside that one cold-start moment. This decides what a user-typed exercise **is**, who completes it, and through which seam it is written.

The naive answer — "just allow a text box" — is right about the affordance and wrong about the row. A catalog row is not a label: CONTEXT calls it *"the join key that makes per-muscle volume and other analytics derivable from the Log"*, and it drives the logging field layout. A bare string produces a row with no muscles, no movement pattern and no tracked metrics, so an exercise you train hard contributes **zero volume to every muscle** in the analytics the coach reasons over — silently, and correctly, given what was stored. Everything below exists to make the text box safe.

## The row is minted immediately, name-only

Typing a name creates a usable catalog row at once. It carries the name and nothing else; the coach fills in the metadata later. There is **no visible marking** of an un-enriched row — no badge, no "needs review" state.

The alternatives were a structured tail (name plus tracked metrics, maybe primary muscle) and a synchronous coach resolution before the row becomes usable. Both were rejected for the same reason from opposite directions: the metadata is exactly the part the coach is better placed to author than the user, so asking the user for it is a form in the middle of authoring that collects worse data, and asking the coach for it *synchronously* puts a model round-trip between the user and a text field. The user owns the name; the coach owns everything else. That split is the decision.

Silent rather than marked is the part taken on reasoning alone — see *Consequences*.

## Duplicates are prevented at type time, not reconciled later

The picker matches **fuzzily and normalized** over the loaded catalog, and `create "X"` is the last row: you must visibly walk past an existing match to mint a duplicate. Since the row is the join key, three spellings of one exercise split its volume three ways, and the coach reasons over the split — a failure that surfaces months later, on history already dirty.

Coach-side merge (the enrichment pass noticing two rows are one exercise and proposing a union) is **not** taken. It is available if fuzzy matching proves insufficient, but it is recorded here as what it actually is: rewriting the join key on historical Entries is a data migration, not a metadata edit, and it should be grilled as one rather than slipped in as an enrichment feature.

## Creating an exercise is its own seam, outside the Plan operation union

[ADR 0015](./0015-plan-authoring-is-one-operation-union.md) closes the `Plan operation` union and mints exactly one Change per accepted operation. A catalog row is **not part of the Plan** — it is shared metadata that outlives any Plan and is referenced by past Logged Sessions. So creating one mints no Change: no Plan changed.

The gesture "add Zercher Squat to Push Day" is therefore two writes — create-exercise, then `addEntry` with the new id. Two options were rejected:

- **Widen the union with `createExercise`.** One seam, one `commandId`, outbox and retry semantics for free — but it puts a non-Plan write into the *Plan* operation union and mints a Change for something that changed no Plan.
- **Let `addEntry` take a name and create on demand.** Genuinely atomic — but `addEntry` becomes two operations wearing one name and its "adds an Exercise from the catalog" contract dissolves.

The clunkiest option was taken deliberately. ADR 0015's union earns its value by being closed and about the Plan only; two writes for one gesture is a UI concern that can be hidden, whereas a union that has begun absorbing adjacent writes cannot be un-blurred later.

A dead spot between the two writes leaves an **orphan catalog row** — an exercise nothing references. This is tolerated. Sweeping it would require a reference count across Plan Entries and all Logged Sessions, which is the same machinery deletion needs and is declined below for the same reason.

## Creation is online-only

`useExerciseCatalog` deliberately does not cache: a catalog shown offline would only let the user pick something it could not then add. With the seam above, creating is a *second* connected write, so the `create "X"` row is **disabled offline with a plain reason**.

This assumes plan authoring is a couch activity, not a gym one. Routing the catalog write through the outbox (client-minted id, both writes replaying in order) and letting *logging* capture an unplanned exercise as un-joined free text are both real answers, and both are deferred rather than dismissed.

## Enrichment is a plain write, not a Decision

[ADR 0011](./0011-deliberation-internals-run-mechanics.md) has the deliberator never write and the runner perform the only write-back, and every coach output today is a `Decision` — Proposal, Observation or Answer. Silent enrichment fits none of them: a Proposal gates on acceptance (you would be approving a card reading *"I think the Zercher squat trains quads"*), and an Observation is a finding that accumulates as evidence toward a trend, which this neither is nor does. Filing it as one would pollute the mechanism carrying the anti-twitchy guarantee.

So enrichment widens ADR 0011's write contract on purpose. The deliberator returns catalog rows to fill; the runner writes them; nothing lands in the Decision log. The line, stated once here because it will be needed again:

> **The coach writes a Decision when it exercises judgment about the user's training, and a plain write when it states a fact about the world.**

Which muscles a Zercher squat trains is lookup, not judgment. It needs no approval and no audit trail. What the user should do about their squat is the other kind, and stays a Decision.

The precedent is already in the tree: accepting an Intake draft writes catalog rows for exercises the coach named, alongside the Plan, with no Decision of their own ([#75](https://github.com/astefanovic/repcoach/issues/75)). That write was made without the line being stated; this ADR states it, and enrichment is the second instance rather than the first.

Catalog metadata is consequently **mutable** — unlike a Decision, it can be re-derived and overwritten. That is what lets a rename re-run enrichment.

## Enrichment rides Session review

There is no free-floating coach process; the runs that exist are Session review (on Finish Workout), Cycle review (monthly), Revision and Intake. Enrichment sweeps un-enriched rows on **Session review**: no new run type, no model call per name typed, and the latency is self-correcting — you added the exercise in order to train it, so a run is coming.

The consequence is precise: **the first logged instance of a new exercise is un-joined at the time it is logged**, and joins retroactively when that session's review lands. This heals cleanly because volume is *derived*, not stored — backfilling the metadata repairs the history rather than leaving a hole in it.

Cycle review alone was rejected as the worst version of the gap (up to a month of under-counted volume). A dedicated run fired on creation was rejected as reintroducing the synchronous resolution already declined above.

## Rename yes, delete no

A catalog row can be **renamed**; it cannot be deleted.

Renaming is not a convenience — it is the pressure valve that makes silent enrichment safe. Create `Zercer Squat`, and the coach enriches whatever it makes of that, permanently and invisibly. Rename keeps the id stable, so history and every reference stay intact, and it re-runs enrichment against the corrected name.

Deletion is declined whole. A row referenced by past Logged Sessions cannot be removed without orphaning history, and distinguishing "referenced" from "orphan" is the reference count named above. Unused rows sit in the picker, slightly untidy; that is the whole cost, and it buys skipping the referential-integrity question entirely.

## Consequences

- The Exercise catalog is no longer purely coach-authored. It is **jointly authored**: the user supplies names, the coach supplies metadata. CONTEXT's `Exercise catalog` term is sharpened accordingly, and `User-authored exercise` is added to name the name-only row.
- The catalog acquires a second class of write alongside the seeded rows, and ADR 0011's "the coach only writes Decisions" is now "the coach writes Decisions and facts", with the line drawn above.
- Orphan catalog rows and rows for exercises never trained accumulate with no sweep. Accepted as untidiness, not as debt to repay.
- Adding an exercise is two round-trips, and the UI is responsible for making that read as one gesture.
- **Silent enrichment is a bet.** Per-muscle volume is briefly and invisibly wrong after each new exercise, and there is no way to tell a well-enriched row from a badly-enriched one. Recorded as [uat-watchlist entry 6](../design/uat-watchlist.md) — the fallbacks are marking un-enriched rows, or making enriched metadata reviewable.
- What tracked metrics a name-only row renders in the logging grid *before* enrichment is left to the existing fallback (fields derived from target keys, per `loadEntriesForBlock`'s LEFT JOIN tolerating a NULL). Not grilled; revisit if the fallback reads wrong.
- ~~Whether the coach may propose *new* exercises into the catalog on its own initiative — as opposed to completing ones the user named — is left open.~~ **Resolved: it may, through a Proposal the user accepts.** Leaving it open turned out not to be neutral. Intake could already author an Exercise (`materializeDraftPlan` mints a row per unknown `exerciseId` in an accepted draft), so a review cadence *not* being able to was an asymmetry, and `addEntry` — which carries an `exerciseId` and nothing else — resolved it by failing open: the Entry applied, pointing at a row that did not exist. A `catalog_exercises` array on the Proposal carries the rows, written on Accept immediately before the operations that name them; `addEntry` now refuses an id that joins to nothing. Deliberately **not** a Plan operation (§3): creating an Exercise changes no Plan and mints no Change. Deliberately written at Accept rather than at commit, unlike `catalog_enrichments`: catalog rows are permanent, and a rejected Proposal must leave none behind. Whether the coach's own naming stays disciplined — or drifts into near-duplicate rows that split a lift's history — is untested; recorded as [uat-watchlist entry 9](../design/uat-watchlist.md).
