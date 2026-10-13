# UI surfaces — stubs for design

The screens/surfaces the architecture implies, derived from [CONTEXT.md](../../CONTEXT.md) and [docs/adr/](../adr/). Each surface notes its purpose, key elements, and the domain concepts it realizes.

Most entries here are **pre-design stubs**, not final specs — a starting frame for a design session; see [open-questions.md](./open-questions.md). Where a surface has been through a design ticket it carries a **"Settled by the prototype"** section, and *that* section is binding where it contradicts the stub above it. Today **Logging** ([#63](https://github.com/astefanovic/repcoach/issues/63)), **Plan view** ([#45](https://github.com/astefanovic/repcoach/issues/45)) and **Intake** ([#64](https://github.com/astefanovic/repcoach/issues/64)) are settled.

Platform: **plain React web app**, phone-first, local-first (offline-tolerant). Native Android is retired outright by [ADR 0012](../adr/0012-web-only-client-supersedes-native-android.md), which also regresses push to web push (and therefore behind the PWA step). Tone implied by the product: an evidence-grounded coach that is candid about uncertainty (never a black box).

---

## Today (home)

**Purpose:** "what do I do right now." The default screen.
**Elements:** today's prescribed Session from the Plan (exercises, target sets/reps/load); a start-workout entry point; the pre-session Check-in prompt; on the Coach destination glyph, a badge counting pending Proposals plus an [activity pip](#deliberation-run-visibility) for unseen coach runs ([#150](https://github.com/astefanovic/repcoach/issues/150)).
**Minimal-Plan behaviour ([ADR 0007](../adr/0007-minimal-plan-is-degenerate-manual-plan.md)):** under the Manual Plan model there is no auto-selected Session — the user **manually picks** today's Prescribed Session from the Plan's ordered list; picking one **instantiates** it into a Logged Session and opens logging. No weekday/rotation auto-select (those assume cyclicity → future cyclic Plan model).
**Next up ([ADR 0023](../adr/0023-next-up-is-a-derived-rotation-hint-not-a-schedule.md)):** a hero in the Resume slot — `Next up · <session> · Start` — naming the session after the one your last finished workout came from, wrapping at the end of the list. The full list stays below in authored order. Resume always wins the slot; offline, the hero's Start is disabled like the rows; with nothing startable there is no hero.
**Realizes:** Plan, Session (Prescribed → Logged on start), Check-in.

## Logging (in-workout)

**Purpose:** fast, glanceable, offline capture of actual performance against the prescription. Pure actual-capture — never mutates the Plan ([ADR 0006](../adr/0006-logging-is-pure-actual-capture.md)).
**Elements:**
- **One-tap confirm:** prescription shown as ghost text in the set row; tapping the checkmark logs the target as actual. Type only to deviate (override the ghost value). When the prescribed value is a **range** (e.g. reps 8–10), one-tap resolves to the **top of the range** (double-progression intent); type a lower number to deviate. When the Exercise has been performed before, each row instead **suggests what its counterpart lifted last time** (same Set type, same position) and shows that number in place of the plan's; one-tap writes it, and the range shows only for an exercise with no history. A metric the plan has moved since last time (an accepted Proposal's new load) shows the plan's number instead. Once a logged Set departs from its last-time value, or with no history once an earlier like-prescribed Set is logged, one-tap **repeats that Set's actual** (RPE excepted). Nothing is printed under the value: the row shows what ✓ writes ([ADR 0021 amendments](../adr/0021-one-tap-confirm-seeds-an-unprescribed-metric.md#amendment-2026-10-08-uat-last-time-set-by-set-over-the-plans-range)). **Add exercise** under the last Entry adds one mid-workout, from the catalog or by typing a new name ([ADR 0019 amendment](../adr/0019-a-swap-is-an-entry-level-actual-side-annotation.md#amendment-2026-10-08-uat-an-exercise-added-mid-workout-is-a-swap-on-a-new-entry)). A metric the prescription leaves **open** (e.g. an unprescribed load) shows a **seeded actual** on the row as `~N` — last Set this session, else the last time the Exercise was performed — and one-tap writes it ([ADR 0021](../adr/0021-one-tap-confirm-seeds-an-unprescribed-metric.md)); only a metric with no seed at all still shows `–`. (A logging convention, not a Plan-shape rule — see [ADR 0007](../adr/0007-minimal-plan-is-degenerate-manual-plan.md).)
- **Set rows render the metrics the Exercise catalog declares** for that exercise — reps/load, or duration, or load+distance, etc. No fixed reps/load layout.
- **Rest timer:** auto-starts on set confirm as an ambient pill; vibrates and dismisses at zero. Duration comes from the prescription; **if the Plan doesn't track rest, no timer** (no forced default). Rest is a prescription attribute, never a logged Set metric.
- **Special set-types** (drop / myo-cluster / rest-pause): when prescribed, they render automatically; when spontaneous, they hide behind a single per-Exercise affordance (a "+"/overflow on the Entry), so the straight-set case stays clean.
- **Blocks** surface **only** when superset/circuit/EMOM/AMRAP is used — a plain day shows just exercises + sets. Prescribed Block formats render their wrapper automatically.
- **Warmup sets:** optional, de-emphasized, `warmup`-tagged, excluded from analytics by default.
- **RPE/RIR:** captured only on sets the Plan flags "report effort" (keeps the rest one-tap). A settings control moves this off the default in either direction — **off** (never ask), **flagged only** (the default), **every set** (effort as a normal prescribed field again). Three states, not a toggle: "show it everywhere" and "never show it" are different wishes and neither subsumes the other ([#81](https://github.com/astefanovic/repcoach/issues/81)).
- **Edit/backfill:** past Sessions reopen in the same surface; unplanned work adds a no-prescription Entry; a swap *may* link to the prescribed slot (soft preference).
**Realizes:** Session → Block → Entry → Set, Progression rule (targets), prescribed-vs-actual delta, Exercise catalog (field layout). See [ADR 0006](../adr/0006-logging-is-pure-actual-capture.md).

### Settled by the prototype ([#63](https://github.com/astefanovic/repcoach/issues/63))

Built at 412×915 (Pixel 7) inside the #42 chrome. Reference build: `thin-client/apps/web/src/prototype/spec/Logging.tsx`.

- **The rest timer is a pill pinned to the BOTTOM of the surface, not a band under the header.** The earlier take hung it directly below the status strip, putting two coloured single-line bands within ~24px of each other carrying unrelated meanings — system state (yellow, offline) and workout state (green, resting). Rest now sits at the opposite end from the strip, in the thumb arc, floating over content instead of pushing it, with the countdown draining *inside* the pill so the colour stays confined to one object. When neither the Set nor its Entry prescribes rest, the pill never appears.
- **There is no reps/load pair anywhere in the rendering code.** The set row is a map over the Exercise catalog's declared metrics. A Plank renders one duration field, a Farmer's Carry renders load + distance, a Pull-up renders reps alone. This is the mechanism, not a special case.
- **Deviation has no edit mode.** The ghost prescription *is* the input: tapping a value opens a stepper over that field only (±2.5 load, ±1 reps, ±5 distance). As-prescribed is one tap, deviating is two, and there is no save button. Tapping a logged ✓ un-logs it — backfill needs an undo, and a long-press is undiscoverable with chalk on your hands.
- **Deviation is per-METRIC and carries the yellow on the value itself**, with a signed delta beside it (`7 reps · −1 rep`). Hitting the reps at the wrong load is a load problem and only the load goes yellow.
- **A Block's wrapper is a left rule and a label** — `[SUPERSET A] · 3 rounds`. In a card-less language the wrapper cannot be a container, so it is a margin mark spanning the grouped Entries. Rounds are *stated*, not structural: the rows do not reinterleave. The label is **not** red — a Block is structural, and red stays reserved for the coach's proposed change.
- **One pencil per Entry holds everything spontaneous** — extra set, drop, rest-pause, myo-cluster, remove a set, swap, note — with "another straight set" first so the common case stays cheap. Prescribed specials render inline, indented under their parent, kind named. It opened as a "+", and UAT retired that glyph once the sheet stopped being purely additive (below); the control's accessible name, `More for <exercise>`, never depended on the glyph and did not change.
- **RPE chips appear only on Plan-flagged sets, and only after the set is logged**, so they can never cost the unflagged majority a tap.
- **Backfill reuses the surface** with the timer gated off, `Backfill · <date>` in the header, `editing a past session` in the strip, and "Save changes" instead of "Finish session".
- **Empty states:** a live Session with no Entries invites adding work as you go; a backfilled one offers to add what you did or discard it.

**Left open deliberately:** whether desktop backfill deserves an entry point distinct from live capture. #42 recorded the counter-argument and chose to discover it from use.

### Settled by "Add a note" ([#130](https://github.com/astefanovic/repcoach/issues/130))

The one "+" sheet item (above) that is not a Set: free text against the Entry, reaching Deliberation through the same Context-note channel a life-context note uses (CONTEXT `Context note`), just carrying an optional Entry anchor.

- **The indicator IS the note, read inline.** No card, no accordion to expand, no colour promotion — a note is an observation, not a deviation, and yellow stays reserved for that (#113 item 2). It renders as a plain muted line directly under the Entry's exercise name; an Entry with a note still reads as an Entry.
- **Composing is a second sheet, not an inline field.** Tapping "Add a note" opens a titled sheet (`Note · <exercise>`) with a textarea and a single "Save note" action — prose needs room a one-line sheet item doesn't have, unlike the Set-type items that write in one tap.
- **Offline-first, same as a logged Set.** The note is captured through the outbox immediately, renders with a small "queued" mark while unsynced, and survives a reload — never a second-class write path.
- **~~One editable note per Entry is NOT enforced; multiple notes are allowed.~~ Overturned by UAT — the item now edits.** #130 argued a workout can generate more than one observation worth keeping ("left elbow twinged on set 3", later "elbow fine by the last set"). Daily-driving showed the second of those is almost always a *refinement of the first*, not a second observation: appending turned one thought into a stack of near-duplicate lines under the exercise name, and handed the coach what reads as several separate reports of one thing. So an Entry that already has a note opens the sheet on that note's text and rewrites it in place ("Edit the note"); only an Entry with none adds. Notes written before the change are untouched — an Entry can still be carrying several, and the item edits **the most recent**, which is the only reading that stays stable across the boundary.
- **Removing a Set is offered beside the four ways of adding one, and means exactly one thing.** The sheet grew four ways to add a Set before it grew any way to take one back, so a mistyped drop set could only be undone by leaving the surface and coming back. "Remove a set" lists only what it can honestly remove — a Set added *this session* that nothing has been logged against — because the two neighbouring cases already have their own answers: a logged Set comes off through retraction ([#83](https://github.com/astefanovic/repcoach/issues/83)), and a prescribed Set belongs to the Logged Session's frozen copy, which the actual side never rewrites. With nothing to list, the item is visibly disabled and says why, never hidden.
- **A cancelled session keeps its notes.** Cancel (#114) never deletes rows; a note added before cancelling stays anchored to the now-cancelled session rather than being orphaned or blocking the cancel — cancel's guard is still "zero logged Sets", unchanged by this ticket.

## Coaching feed

**Purpose:** the proactive stream where the coach surfaces Proposals and insights, including cross-cutting observations (recovery, balance, lifestyle).
**Elements:** chronological cards; Proposals vs informational insights; arrives via push when the home-server runner produces them.
**Realizes:** Coaching feed, Proposal, Observation.

### Settled by the build ([#79](https://github.com/astefanovic/repcoach/issues/79))

**Coach is the record, not a feed.** #42 split one stream in two and #79 built the second half: Today carries what is still owed a decision, Coach carries everything the coach has ever said. Nothing leaves it. So Coach has **no actions** — Accept/Dismiss/Revise live on the undecided item on Today, and offering them again on the record would be offering to decide twice. What the record adds instead is **outcome**: each item states what became of it ("awaiting your decision on Today", "accepted — applied to your plan", "dismissed", "superseded by a later version"). Dismissal reads neutral, never as failure — ADR 0008 keeps a rejected Proposal as context the coach learns from.

**The working got a contract.** The card's evidence blocks were fixtures until this ticket, because `measurements`, the named `rule` and `uncertainty` existed nowhere in the run-output contract — only citations and the data window were ever stored. They are now three **optional** fields on the agent's output (ADR 0011 §6, migration 008), fetched per item through `decisions.get` when an item is expanded rather than shipped with the feed.

**Optionality is the design, not a compromise.** Every block renders only when the run filled it in. A card that always shows "Where this could be wrong" teaches the user to skip it; one that shows it only when the coach named something concrete makes its presence mean something. There are no placeholder rows and no "none given" — an absent field is an absent block, all the way down to the store, which never back-fills `null` into `[]` or `""`.

**Two things #43 designed are gone, because nothing stores them.** The provenance footer's model id and token count are not persisted per Decision (`RunState` knows only the last run's usage), so the footer names what the data window genuinely holds — cadence, when it ran, how much it read, roster version — and nothing else. A footer naming a model would have been naming a guess.

**Offline says so.** The record is online-only (ADR 0002/0008): disconnected, it states that the record lives on the home server and cannot be read, rather than presenting the last thing it received as current. It does not show a spinner that will never finish.

Artifacts are `thin-client/apps/web/src/surfaces/Coach.tsx` and `coachItem.tsx` — the latter shared with Today's Proposal card, so an item reads identically in both places and the two cannot drift.

### Settled by the prototype (the run history)

**The record is a list of RUNS, not of Decisions.** The prototype ([PR #140](https://github.com/astefanovic/repcoach/pull/140)) put three shapes on screen and variant B won: one vertical rail, newest at the top, every run a node coloured by outcome, opening into its two stages (deliberator → Adversarial sweep) and the Decisions that came out the far end.

**Because three of the coach's four states had no representation at all.** A list of Decisions can only show the runs that *said something*, and the states worth seeing most are the other ones:

- **A run that looked and had nothing to say.** Restraint is the anti-twitchy mechanism ([ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md) §4) — but it writes zero rows, so a restrained coach and an absent coach were the same screen. The record now says "read 3 sessions, said nothing", and that sentence is the evidence the mechanism is working.
- **A run that failed.** Its reason lived only in the runner's memory and died on restart, so "the coach has been quiet" and "the coach has been crashing" read identically the next morning.
- **A run in flight.** It is simply the top node, which is what makes watching the coach work and reading what it did afterwards **one list** rather than a banner above a log.

Making those sayable is a **data** change, not a presentation one: the Deliberation run got a row of its own (migration 020, ADR 0011 §8), written by the runner and only the runner, best-effort so that losing the record of a Decision can never cost the Decision.

**Two levels of disclosure, because they answer different questions.** Opening a run asks *what it did*; opening a Decision inside it asks *how it got there*, and lands on exactly the working #79 built, fetched per Decision through `decisions.get`. Everything above still holds unchanged — no actions, outcome instead, optionality, offline honesty.

**The stages are here; the spend is not.** The deliberator and the sweep are on the node because the sweep's one-way authority is *why* a Decision can be trusted (ADR 0011 §1) — a record that hid it would be hiding the trust floor. Tokens, model and cost stay in Settings' spend section, even though the run ledger has all three one join away: this surface asks how the coach reasoned, and a token count would turn an explainability surface into a telemetry one.

**History predating run rows is reconstructed, and says no more than it can.** Older Decisions are grouped by the `data_window_json` they share, which recovers the runs that emitted something and cannot recover the ones that did not. A reconstructed run therefore claims no stages at all rather than asserting two nobody recorded.


## Proposal card (layered explanation)

**Purpose:** act on a proposed Change with full, auditable reasoning.
**Elements:** **top** = one-line cited summary ("e1RM +4% over 4 sessions → add load [src]"); **expand** = deeper evidence, data window, the rule/observation chain, full Citations each showing trust level (corpus-verified vs retrieved-unverified); **actions** = Accept / Dismiss / **Revise**.
**Revise ([ADR 0013](../adr/0013-revise-user-invoked-amendment-of-a-drafted-decision.md)):** the free-text channel to interrogate ("why?"), object ("not 5 days"), or request alternatives — it re-invokes Deliberation on that Decision. It expands **in place, below the actions, same column, same surface**; submitting does **not** navigate. No chat destination, no thread view (the [#42](https://github.com/astefanovic/repcoach/issues/42) IA constraint).
- **In flight:** the card **locks behind a spinner** — no Accept, no Dismiss, no second Revise. The spinner label distinguishes **queued** (deferred behind subscription quota, [ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md) §8) from **running**, so the lock explains itself. The persistent status strip picks up `coach running`; the transient green flash fires when the run lands. A pushed-back Proposal is explicitly *not* decided, so it **stays on Today**.
- **Cancel** is the only escape from the lock: a queued run is dropped, a running one is abandoned, and no rows are written either way. Without it a stalled run would strand a Proposal permanently un-acceptable.
- **Result:** exactly one **Answer** (cited prose, always) plus **at most one revised Proposal**. A revision supersedes the original and becomes the new pending head on Today — never two pending Proposals side by side. No revision → the original stands and the Answer appends.
- **Lineage:** the card renders `[current Proposal] + [collapsed history]` — the user's Revise prose, the coach's Answers, and a collapsed "previous version" per superseded Proposal, all but the current turn folded. Multi-turn is sequential and uncapped; older turns collapse so the card stays a card.
- **Bundled constraint promotion:** a revision may also propose promoting the objection to a **Standing constraint** ("…and record 'max 3 training days' as a standing rule?"). One card, one Accept, both effects — so the card must **say plainly** that Accept installs a durable rule.
**Realizes:** Proposal, Proposal lineage, Decision, Answer, Revise, Revision run, Citation, Standing constraint, the chat-as-interface principle ([ADR 0002](../adr/0002-deliberation-pipeline-not-live-chat.md)).

## Decision log / history

**Purpose:** the auditable, queryable record of every coaching Decision — the "story of your training."
**Elements:** searchable/filterable timeline; each Decision shows what changed, rationale, citations, data window; links from a Plan element to the Decisions that shaped it.
**Realizes:** Decision log.

## Plan view

**Purpose:** see the standing Plan and the shape of the current cycle.
**Elements:** the prescription per training day; the Plan model's structure made visible (e.g. "accumulation week 3, deload week 6" — but only if the active model is cyclic); proposed edits shown as diffs.
**Minimal-Plan version ([ADR 0007](../adr/0007-minimal-plan-is-degenerate-manual-plan.md)) — the manual authoring surface:** under the Manual Plan model the Plan view is an **ordered list of named Prescribed Sessions** (no cyclic weekly grid — that's a future cyclic model's visualization, e.g. the design mockup's "accumulation week 3/6"). It is the **only** Plan-authoring path (Intake excluded); the first Plan is created from its empty state. CRUD:
- **Templates:** create / rename / delete / reorder Prescribed Sessions.
- **Within a template:** add / remove / reorder Entries from the Exercise catalog; group Entries into a superset/circuit Block; edit each Entry's ordered list of prescribed Sets.
- **Per-Set authoring sugar:** "N identical sets"; rep range input (reps only in v1; load/RPE single-target); per-Set rest with an Entry-level default; "add drop / rest-pause / myo-cluster set".
- **Deferred in the editor:** EMOM/AMRAP authoring, prescribed warmups, progression rules (none here — every target is hand-entered).
- An edit **auto-applies** and is recorded as a `user-direct` Change ([ADR 0008](../adr/0008-plan-changes-carry-origin-and-status.md)); editing never touches past/in-flight Logged Sessions (they are copies).
**Realizes:** Plan, Plan model (Manual), Prescribed Session, Entry, Block, Set, Change.

### Settled by the prototype ([#45](https://github.com/astefanovic/repcoach/issues/45))

Reference build: `thin-client/apps/web/src/prototype/spec/Plan.tsx`.

- **You author set GROUPS, not set rows.** `4 × 5–8 reps @ 80 kg` is one object with a count. ADR 0007's "N identical sets" sugar is promoted from a convenience to *the* authoring unit — it is the only way nested set editing fits at 412px, and it is how a person says it out loud. Tapping the sentence expands it into sets / metric targets / rest / effort. A group of count 1 is just a set. **Logging expands groups into rows; the Plan never sees rows.**
- **Reordering is a mode, not a gesture.** Long-press-drag on a nested list at 412px is undiscoverable and fights the scroll container. A per-list "Reorder" toggle *replaces* each row's affordances with ↑/↓ rather than adding to them, so the resting state carries no arrow noise.
- **Reordering has exactly two levels, and the outer unit is the NODE** — a Block or a lone Entry. The Block header carries the move controls and reads `moves as one`; moving it takes its Entries with it. Entries inside a Block move only among their siblings, because A1/A2 order in a superset is prescription, not presentation.
- **Blocks are made by adjacency, not selection.** "Group with the exercise below" on the Entry's own menu. If the node below is already a Block the Entry *joins* it, so circuits can exceed two exercises. "Take out of <block>" is the inverse, and **a Block of one collapses back to a plain Entry**. Multi-select would need a selection mode, a toolbar and a cancel; adjacency is the whole feature for a v1.
- **There is no save button, so the change ledger is visible.** Every mutation routes through one commit path — nothing can edit without writing a `user-direct` Change — and the ledger renders the last few, stamped and undoable. Undo restores the prior Plan, not just the log line. ADR 0008's auto-apply is only trustworthy if the app can show what it applied.
- **Colour follows the shared semantics, and Plan contains no red.** Green marks the session being edited, an applied Change, an affordance that is ON, and the finishing button. Yellow marks a template with no Entries or a set group missing a target for a metric its Exercise records — both are "cannot be run as written", which is caution, not error. Red is absent because Plan authoring holds no coach proposals; a coach-proposed plan change arrives as a diff, and *that* is what gets to be red.
- **Empty state** is the manual path to a first Plan, and points at Intake without stealing the hero from it (#42 makes Today's empty state the Intake invitation).
- **Deferrals are printed where you would look for them** — EMOM/AMRAP authoring, prescribed warmups and progression rules read as decisions rather than gaps.

**Two findings handed forward:**

1. **The #42 column split does not survive Plan unchanged.** #42 specifies left `1fr` / right `30rem`; on Plan the right column is an *editor*, so a flexible left spends width on the least dense thing on screen. The prototype uses `20rem / 1fr` — column *order* is preserved (list left = list on top), only the fixed/flexible assignment flips.
2. **Plan is where "column order equals phone stacking order" costs most.** The editor starts ~544px into an ~899px viewport, so every return to it scrolls past the session list. Mitigated with scroll-into-view on selection. Whether Plan earns `/plan/:sessionId` as a real phone-level route is **not settled**.

**Not built:** moving an Entry directly between two Blocks, and reordering Blocks other than by stepping through intervening nodes. Both are drag-and-drop problems wearing a button costume, and neither is in scope.

## Intake

**Purpose:** cold-start to produce the first Plan when no Log exists.
**Elements:** short structured form (days/week, equipment, lifts + current weights); then an **interactive** agent-led pass ([ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md)) — the agent drafts a first Plan and presents it ("what do you think of this plan?"), the user **tweaks it on the fly** while the agent revises, converging on the first Plan surfaced as an **accept-able Proposal**; an explicit "calibration phase" message setting expectations. This is the *one* interactive Deliberation run (all others are fire-and-forget) — but it still amends a *drafted* Decision, not free-chat coaching (ADR 0002).
**Realizes:** Intake, Deliberation run (Intake config), Goal, Calibration phase, first Decision.

### Settled by the grilling ([#64](https://github.com/astefanovic/repcoach/issues/64))

Full reasoning in [ADR 0014](../adr/0014-intake-one-held-open-run-swept-once.md), which amends [ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md) §7 and §8. Built inside #42's `ModeShell` with the status strip omitted.

- **The form asks only what a model cannot guess** — Goal (free text, deliberately vague), days/week, equipment chips, and lifts + current weights, which is **skippable**. One scroll, no wizard, submit gated on the first two. Anything needing judgment moves into the pass, where the agent can ask it *about a concrete draft* instead of in the abstract.
- **Intake is ONE run with many turns; Revise is N runs of one turn each.** A held-open deliberator session, resumed turn to turn — cheap turns, no per-turn sweep, no per-turn Decision row. ADR 0013's heavy Revision run exists to re-read the Log and settle arguments about data; at cold start the database is empty, so that reasoning is vacuous. The coach asks questions back, with quick-reply chips where the answer is a closed set. ADR 0013 itself is untouched.
- **Interim citations are shown and marked provisional**, with a tooltip promising verification at review — so the pending sweep is a visible promise, not a backstage step.
- **Two waits, treated differently.** Cold: the form collapses to a one-line summary that stays pinned, and a live activity line driven by real tool events replaces a fake progress bar. Turn: the draft stays, the input disables. Spend gets one provenance footer (`intake · model · N.Nk tokens`).
- **Intake is exempt from the deferral queue** — the only user-blocking run in the app. Quota-starved, it fails loudly and points at Plan view's manual empty state, because a queue position is not actionable for an abandonable cold start.
- **"Review the sources" is a distinct act from Accept, and the single Adversarial sweep sits between them.** The swept output renders as the real Proposal card, badges and all, and **discloses its own edits** ("two sources didn't hold up"). The sweep governs the justification, never the prescription. Accept then commits, applies the `coach-proposal` Change, creates the Plan, and exits to a populated Today — never pending on Today, never in the Coach badge. Cold-start divergences: the payload is the whole Plan, not a diff.
- **The Calibration-phase note arrives with the first draft**, under the plan hero, in the coach's voice, naming what unlocks real coaching. Never before the form, never dismissable, carried into the Decision.
- **Failure:** offline routes to the manual path (there is no local coach); a failed cold draft returns the form with values intact; a failed turn is a genuine no-op; a failed sweep offers no Proposal; **a sweep that guts the plan is not an error** — thinner rationale, still acceptable. Abandonment confirms only once there is a draft to lose; reload discards it, with no persistence and no session resurrection. **There is no Intake empty state** by construction.

**Handed forward:** whether the calibration phase deserves any post-Intake presence on Today or Progress; and whether the swept card's "what verification changed" disclosure should generalize to every Proposal (it is only *required* at cold start).

### Settled by the prototype ([#64](https://github.com/astefanovic/repcoach/issues/64))

Reference build: `thin-client/apps/web/src/prototype/spec/Intake.tsx` (+ `intake-data.ts`), inside `ModeShell` with the strip omitted, with the agent canned and every §8 state staged on `?intake=…`. **Deleted by [#74](https://github.com/astefanovic/repcoach/issues/74)**, which ported the surface onto the real runner — read it at PR #73 if the reasoning at the point of each decision is wanted; the shipped surface is `apps/web/src/intake/IntakeTakeover.tsx` over `@repcoach/client-runtime`'s `Intake` module. Amendments to the section above:

- **It does not read as a chat, and the mechanism is that there is no thread at all.** "Draft as hero, turns attached to it" is achievable two ways, and only one works. Exactly **one open question is ever on screen**, directly under the thing it is about; an answered turn does not become a message, it collapses into a **revision ledger**. Nothing bubbles, nothing alternates left/right, nothing accumulates downward — the scroll position barely moves across four turns, which is the tell. A chat grows; a draft gets revised in place.
- **The ledger line is what the answer DID TO THE PLAN, not what was said.** "Lower back → RDLs out, hip thrust and leg curl in" is the line; `you answered: Bad lower back` is kept underneath, subordinate. That inversion is the whole not-a-chat argument in one row, and it is why the collapsed ledger is readable as a changelog rather than as a folded transcript.
- **The draft carries a revision number** (`draft 3` → `verified` after the sweep). It is the cheapest available signal that the object on screen is the *same* object as a turn ago, changed — and without it four revisions do start to read as four messages.
- **§3's tooltip becomes tap-to-reveal.** A phone has no hover, so a `title=` promising later verification is undiscoverable on the device this ships to — and the promise *is* the feature. `[provisional]` is a button that expands the source plus "not checked yet — every source gets verified when you review the plan". Same decision, an interaction the target device actually has.
- **The cold wait needs a growing list of activity lines, not one line mutating in place.** A single swapped string is precisely the "spinner with extra words" §4 warned about. Past steps stay, dimmed; only the current one carries the pulse. This is also the only thing that gives the wait texture when one retrieval step runs long, which real ones do.
- **The sweep's disclosure must be scoped to the citations the plan actually accumulated.** Converging straight off the cold draft is legitimate — the questions are optional — and a verdict table written for the fully-argued plan then discloses removing sources the user never saw. The wait's activity line reads off the same scoped list, so the count it narrates can never contradict the card that follows it.
- **"The sets and reps you settled on are unchanged" is only shown when something was removed.** With nothing struck through it denies an accusation nobody made. The gutted case adds one further sentence in the coach's voice, and no error colour anywhere: yellow throughout, because this is caution, and caution is the honest reading.
- **The offline check belongs on Today's empty state and is built there.** Discovering the coach is unreachable *after* entering a chrome-free takeover means the takeover exists only to apologise. The empty state swaps its hero for the manual path and states the constraint ("the coach runs on your home server"), not the symptom.
- **Spend appears only once a run has returned.** Rendering the cold draft's full cost while it is still drafting reads as a live counter and is a lie. Turn cost is visibly a fraction of the draft's, which is the useful half of "turns are cheap".
- **"Untouched", for the abandonment confirm, means unchanged since the screen opened** — not "equal to an empty form". Getting this wrong deletes the free-and-silent half of the rule.
- **Quick-reply chips survived contact.** They sit inside the input's own block and vanish with the question they answer, so they read as answers to *that* question rather than as a menu the app is offering. Free text is always present alongside, never behind a toggle.
- **Red appears exactly once, on the swept Proposal.** An interim draft is not a proposal, so nothing in the exchange earns the accent colour — which also means the Proposal's arrival is visible as a change of state rather than only as a change of copy.

### Found while porting ([#74](https://github.com/astefanovic/repcoach/issues/74))

- **The cold wait has no activity line, and cannot have one as the runner stands.** `intake.events` is keyed on the session id and `intake.start` is what mints it, so no subscriber can exist while the cold draft is being written — [#70](https://github.com/astefanovic/repcoach/issues/70)'s own suite records this ("the cold draft's events precede any possible subscriber"). The shipped wait therefore says what it is doing in words with a pulse and **fabricates nothing**, which is §4's actual rule; the growing list survives on the *sweep* wait, where events do reach a subscriber. Closing it means the runner minting the id before it drafts (or accepting a client-supplied one) — a server change, so it belongs to #70's territory rather than to the surface.
- **The swept card has no "where this could be wrong" block.** The prototype carried one from a fixture; `ConvergeIntakeResult` has no uncertainty field, and the calibration note is the caveat that *is* on the payload. Inventing the text client-side would be the app writing the coach's hedge for it.

**Handed forward from the build:** Intake stays **one column** at every width — there is no second column to order, so #45's "column order equals phone stacking order" cost does not apply here and should not be invited. And the revision ledger currently **dies with the takeover**: the calibration note survives into the Decision (§7) but "how this draft got here" does not, which may or may not be right for the Decision log.

## Deliberation run visibility

**Purpose:** make it obvious when the coach is working and what it is spending ([ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md)).
**Elements:** an indicator of the current Deliberation run state — **running / queued** (deferred because subscription quota is low) / idle — and the run's **token usage** (usage counts from the Agent SDK, not a dollar bill — coaching runs on subscription OAuth, [ADR 0005](../adr/0005-deliberation-on-agent-sdk-subscription.md)). Surfaces the deferral queue honestly rather than silently delaying. Likely a small ambient status on the Coaching feed plus a detail affordance.
**Realizes:** Deliberation run, the deferral-only degradation ladder (ADR 0011).

### Settled by the activity pip ([#150](https://github.com/astefanovic/repcoach/issues/150))

Full reasoning in [ADR 0022](../adr/0022-the-coach-glyph-carries-two-signals-a-count-you-owe-and-a-pip-you-havent-seen.md).

- **The Coach glyph carries two independent signals.** The numeric badge counts decisions you owe (pending Proposals, and — #42 story 36 — nothing else). A separate **activity pip** — a dot in the opposite corner of the same glyph — means "a Deliberation run has settled that you haven't opened Coach to see". They never merge and never compete for the badge gutter; both are inside the reserved glyph box, so lighting or clearing the pip reflows no dock slot.
- **What lights the pip:** a `committed` or `failed` run newer than this device's last visit to `/coach`. **Not** a run in flight — that stays the status strip's job, and a pip plus a strip line plus the landing flash for one event is too much chrome. **Not** a new Proposal — that is the count's job.
- **The pip clears on opening `/coach`** (a record surface with no per-item actions — "you opened it" is the only "you saw it" there is), and the "last seen" mark advances to the newest run on the rail, so a strictly newer run re-lights it without any clock-agreement assumption.
- **The mark is device-local** (`localStorage`, like the in-flight pointer): synchronous to read on first render, cheap to be wrong about. A second device keeps its own mark and its own pip — the accepted cost, with the server-side `coachSeenAt` column as the pre-planned fallback → **uat-watchlist #16**.

Artifacts: `thin-client/apps/web/src/runtime/coachActivity.ts` (pure predicate), `coachLastSeen.ts`, `useCoachActivityPip.ts`; the pip markup is on the Coach slot in `ui/Shell.tsx`'s `Dock`/`Sidebar`.

## Settings

**Purpose:** let the owner pick which model each cadence runs on, see what the coach has spent, and turn off a capture surface they do not use.
**Elements:**

- **Model selectors, one per cadence that resolves a model** ([ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md)): Session review, Cycle review, Intake, on-demand. The motivating case is still frequency — a cheaper/faster model for the frequent Session review, a stronger one for the rare monthly Cycle review — and this is where Session-review "restraint" is partly realized (model choice + prompt tone, not a structural cap). Intake and on-demand get selectors for the same reason the other two do: they resolve a model at run time, so without one they run on whatever the SDK defaults to. **Revision runs are shown as non-configurable, with the reason on screen** — they read the Session-review model by design ([ADR 0013](../adr/0013-revise-user-invoked-amendment-of-a-drafted-decision.md) §6), so arguing with the coach can never be the most expensive thing in the app.
- **Spend, as reporting and not control** ([ADR 0013](../adr/0013-revise-user-invoked-amendment-of-a-drafted-decision.md), [ADR 0014](../adr/0014-intake-one-held-open-run-swept-once.md) left cost uncapped on purpose): a per-cadence breakdown (tokens, run count) over the run ledger, plus a short list of recent runs. The list is the part that earns its place — the watchlist questions are per-run comparisons ("a Revise vs a Session review"), which no aggregate can answer.
- **The RPE capture control** — three states, per Logging above.
- **Settings apply immediately.** No save button; this surface reads like the rest of the app.
- **A setting that cannot currently be changed says why** — an unreachable home server is a disabled control with an explanation, not a broken one.

**Realizes:** Session review, Cycle review, Intake, on-demand (model-per-cadence config); the run ledger behind spend.

## Goal & constraints

**Purpose:** view/edit the durable inputs the coach must honor.
**Elements:** the Goal with its measured targets; Standing constraints listed with hard/soft flags; ability to add a constraint; surfacing coach-proposed promotions ("make 'max 4 days' a standing rule?").
**Realizes:** Goal, Standing constraint.

## Progress

**Purpose:** show movement on the proxies the coach chose for the Goal.
**Elements:** strength/e1RM trends per lift; per-muscle weekly volume vs. evidence-based landmarks; bodyweight trend; optional measurements when the coach has requested them — all framed honestly as *proxies for* hypertrophy, not direct measurement.
**Realizes:** Goal (proxies/measures), derived analytics.

---

**Not in v1 UI (deferred):** Health Connect / wearable objective-data screens (out of reach on the web-only client, not merely deferred — [ADR 0012](../adr/0012-web-only-client-supersedes-native-android.md); see `CONTEXT.md` → Check-in); any multi-user / account surfaces (parked behind official OAuth reuse — see [ADR 0005](../adr/0005-deliberation-on-agent-sdk-subscription.md)).
