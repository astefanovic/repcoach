# The Coach glyph carries two signals: a count of what you owe, and a pip of what you haven't seen

Issue #150, from UAT: *"notification pip for coach when a new / in-progress activity."*

## The state before

`ChromeBadges.coach` was one number: the count of **pending Proposals**, and
deliberately nothing else. That scope is a settled decision, not an oversight —
#42 user story 36 asked for a count on Coach so the user knows decisions are
waiting *"without being nagged about observations"*, and
`usePendingProposalCount`'s own doc spells out why an Observation must not
count: *"an Observation is the coach noting something, not asking for anything,
and counting it would make the badge a notification rather than a to-do."*

So two states of the coach had **no representation on the destination at all**:

- **A Deliberation run that finished while you were not looking.** Its "running"
  state was on the persistent status strip, but the strip is wherever you
  happen to be looking and is gone the instant the run lands. A run that
  committed three Observations and a run that committed nothing looked
  identical from the dock the next morning.
- **A run that failed.** Same problem, worse: the failure survived only as
  strip text and a `deliberation_run` row. "The coach has been quiet" and "the
  coach has been crashing" read identically from the glyph.

The reporter asked for a **pip** — a dot meaning *"there is something new"* —
which is exactly the nag story 36 ruled out, re-introduced under a different
mark.

## The decision

**Add the pip, narrowly, as a second and independent signal.** The reversal of
story 36's rule is deliberate and bounded: a coach whose work is invisible is a
coach you stop checking, which is the *same* argument that made `/coach` a
record of runs rather than of Decisions (ADR 0021). Making the work visible is
worth one dot. But the dot is not the count, and the two never merge.

### 1. What lights the pip

**A Deliberation run that has *settled* — `committed` or `failed` — with a
timestamp newer than the last time this device opened `/coach`.**

- **A run in flight does not light it.** "Running" is the status strip's job
  (ADR 0011 §8). A pip *and* a strip line *and* the green landing flash for one
  event is more chrome than the event carries. The pip is strictly about output
  you have not read.
- **A failed run does light it.** It is the state with the least other
  representation, and the one a user most needs to not miss.
- **New pending Proposals do not light it.** Those are the count's job. A
  settled run that happened to emit a Proposal lights the pip *because it is a
  settled run*, and separately bumps the count *because the Proposal is
  pending* — two true statements, two marks.

### 2. Pip and count share a glyph without competing

The badge gutter is a fixed-width slot on every dock/sidebar destination, sized
so Coach gaining or losing its number cannot shift the other three. The pip
does not go in that gutter. It is a small dot, **absolutely positioned inside
the reserved glyph box, in the opposite corner from the count**, so:

- lighting or clearing it shifts no slot — the dock does not reflow;
- there is no "which one wins" rule to get wrong, because they occupy different
  corners and mean different things. A glyph can show a bare dot, a number, or
  both.

The dot itself is `aria-hidden`; the pip contributes the phrase **"new
activity"** to the Coach link's accessible name, because a bare dot announces
nothing to a screen reader.

### 3. "Last seen Coach" is device-local

The marker is `localStorage` (`repcoach.coachSeenAt`), an ISO-8601 timestamp,
the same size of tool `inFlightSession` uses:

- the read must be **synchronous** so the chrome can decide whether to draw the
  pip on its first render, without a flash;
- the cost of a wrong value is **small** — a pip that lingers one extra visit,
  or clears a beat early — never lost data. Compare #147, where a lost
  device-local pointer stranded an *active workout*; nothing that expensive is
  at stake here.

Server-side (a `coachSeenAt` column) is the more correct answer and is the
**pre-planned fallback** — the run list is already server state, so the query
side is cheap; it is a schema migration that a read-state marker does not yet
justify. The two-devices gap (each keeps its own marker and its own pip) is the
named risk → **uat-watchlist #15**.

### 4. Opening `/coach` clears it; a run landing while you are on `/coach`
    clears it too

Clearing on **destination-open**, not per-run — `/coach` is a record surface
with no per-item actions, so "you opened the record" is the only "you saw it"
signal there is. The marker is set to the **newest settled run currently on the
rail** (`seenThrough`), not to `now`: a strictly newer run then re-lights the
pip with no dependence on client/server clock agreement, and a run that arrives
over the live subscription while `/coach` is open — it is right there at the top
of the rail — advances the marker past itself.

### 5. Offline

The predicate is a pure fold (`coachHasUnseenActivity`) over the run list from
`useDeliberationRuns`, which replays the full set on every reconnect. So:

- a replay re-emits the same runs and the answer does not move;
- a run that opened `running` before a dead spot and closed `committed` after
  it flips the pip on exactly once, when the closing emission lands;
- a failed subscription leaves the last run list in place (the same posture the
  count takes), so a dead spot never lights a pip that should be dark or clears
  one that should be lit.

While the runs are still loading or the subscription has failed outright, the
pip stays **dark** — an unproven "there might be something" dot is worse than
no dot.

## Alternatives considered

- **Pip on "running" too.** Rejected per §1 — it duplicates the strip and
  collides with the landing flash.
- **Fold the pip into the count** (e.g. count Observations as well). Rejected —
  it is precisely story 36's "make the badge a notification rather than a
  to-do", and it destroys the count's one clean meaning.
- **Server-side marker now.** Deferred, not rejected — §3. It is the fallback,
  pre-planned in watchlist #15.
- **Clear the pip per-run** (opening a run node marks that run seen). Rejected —
  more machinery than a record surface with no per-item actions warrants, and
  "opened the destination" is a clean enough signal.

## Consequences

- `ChromeBadges` gains `coachPip: boolean`. `Dock` and `Sidebar` each render an
  `aria-hidden` dot plus an `sr-only` "new activity" span on the Coach slot
  only; both are inside the existing reserved glyph box, so no slot reflows.
- New: `coachActivity.ts` (pure predicate + `seenThrough`, unit-tested),
  `coachLastSeen.ts` (the `localStorage` marker, proven by the Playwright
  flow), `useCoachActivityPip.ts` (the wiring). `Coach.tsx` marks the record
  seen on mount and on every run arrival while mounted.
- `BadgedShell` now holds two subscriptions for the Coach glyph —
  `subscribeProposals` for the count and `subscribeDeliberationRuns` for the
  pip. The second is a duplicate of the one `/coach` itself opens; at personal
  scale this is not worth de-duplicating through shared runtime state.
- **Story 36's rule is amended, not overturned.** The *count* still never nags
  about anything you do not owe an answer to. The pip is a separate signal with
  its own honest meaning — "there is coach output you have not read" — and it
  clears the moment you read it.
- **uat-watchlist #15**: does an activity pip actually make you open `/coach`,
  or does it just train you to ignore a dot — and is the device-local marker's
  two-device staleness a real irritation? Fallbacks: pip on runs that *emitted
  something* only (never on a quiet run), or the server-side marker. See the
  entry.
