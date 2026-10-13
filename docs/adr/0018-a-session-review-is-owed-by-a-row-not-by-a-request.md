# A Session review is owed by a row, not by a request

Issue #132. [ADR 0011](./0011-deliberation-internals-run-mechanics.md) §4 says a Session review fires when the user finishes a workout. It did not say *what remembers that the review is owed*, and the implementation answered "the in-flight `finishWorkout` request" — which is how the coach silently never ran for ten days.

## What went wrong

`logging.finishWorkout` committed the `active → finished` transition, then ran the Session review synchronously in the same RPC. Whether a review was owed was decided by `finalizeSession`'s `transitioned` flag.

Those two facts are not the same fact. `transitioned` answers *"did this call finish the session"*; the question that matters is *"has this session been reviewed"*. They agree exactly once — on the first call. When the run failed with the transition already durable, every retry read `transitioned: false` and skipped the review. `runSessionReview` had exactly one caller, so nothing could ever pick the session up again.

Three finished sessions and 103 logged sets were never reviewed. The `deliberation_run_ledger` held zero `session-review` rows — the cadence had never once run in production. Nothing surfaced it: #90's failed-run state lives in an in-memory `SubscriptionRef` and died with the process, and no failed-run feed entry was written.

The same loss had a second route. On low quota the runner defers a run onto `Queue.unbounded` — in memory — and awaits it. A restart while a review sat queued dropped it, session already `finished`, identically unrecoverable.

## The decision

**A Session review is owed by a durable row, and only by a durable row.** `logged_session.review_status` (migration `017`) is `pending` or `reviewed` for a finished session, NULL for `active`/`cancelled`. `pending` is the sole trigger for a review.

Three consequences follow, and the ordering of each is load-bearing:

1. **The status flip and the marker are one write.** If they could land separately, a crash between them leaves a `finished` row invisible to the drain — this bug in a new shape.
2. **`finishWorkout` returns as soon as the session is finalized.** The review is forked into the runner's scope, not awaited. Revise already made this trade for the same reason (ADR 0013 §5); Session review was the outlier.
3. **`markSessionReviewed` runs only after a run has committed.** A marker written before the run reintroduces the loss. This deliberately biases toward a *duplicate* review over a *lost* one: a duplicate is visible in the feed and dismissable by a human, a loss is neither.

**The marker is also the queue.** The drain re-reads `listSessionsPendingReview` on every tick rather than holding a work list, so there is nothing for a restart to drop — the same reasoning migration `011` applied to the Cycle-review schedule ("a home server reboots, and a monthly timer that resets on every boot never fires"). Persisting `deferralQueue` was considered and rejected: it would be a second mechanism answering the same question, and the row already answers it.

**Two callers, one guarded path.** `finishWorkout` nudges the drain so a review starts within milliseconds; a 15-minute poll retries whatever is still owed. Both go through `reviewPendingSessions`, which claims a session in memory before reviewing it. The claim is deliberately *not* durable — a process killed mid-review must leave the session claimable again, and crash recovery is the `pending` row's job. The drain is strictly sequential, so the three-session backlog in the live DB is three runs in order, not three concurrent Opus runs racing for quota.

## What this costs

`FinishWorkoutResult` no longer carries `review`. It cannot: the run outlives the response. Callers get `reviewStatus` instead, and the run's progress arrives where every other cadence's does — the status strip and `subscribeCoachingFeed`/`subscribeProposals`. The RPC also stops blocking the UI on an Opus run, which was a second, quieter defect: "Finish Workout" made the user wait minutes on the coach.

`transitioned` survives as reportable detail and gates nothing. #29's guarantee — a double-tap must not double-review — is unchanged, but it is now carried by the `reviewed` marker and the claim guard rather than by a flag that answers a different question.

## Consequences

- **The migration's backfill is the recovery.** Every existing `finished` row becomes `pending`, so the drain's first tick reviews the three stranded sessions instead of leaving them unreviewed forever. A `finished` row with a NULL marker is read as `pending` for the same reason.
- **A duplicate review is now possible** where previously only a loss was: a run that commits and then fails before `markSessionReviewed` will be re-reviewed. Accepted per point 3 above.
- **The drain is production-only**, like the Cycle-review schedule — the dev-server must never start background runs. In dev and rung 2 the review still happens, via `finishWorkout`'s nudge; a *failed* review is simply not retried there.
- **`scripts/Get-UnreviewedSessions.mjs`** is the read-only lever for "has the coach kept up?", cross-checking the marker against the run ledger. The absence of any such lever is why this went unnoticed for ten days.
- **Two judgement calls here have no evidence behind them yet**: the 15-minute poll interval (a guess at how long a stranded review may wait, on a cadence that should almost always be idle), and the "duplicate over lost" bias, whose cost nobody has seen because no duplicate review has ever happened. Both are uat-watchlist shaped — daily-driving is what will say whether the interval is wrong in either direction, and whether a duplicate Observation is as harmless on the feed as this ADR assumes.
