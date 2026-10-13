# Revise: a user-invoked, scoped Deliberation framing that amends one drafted Decision

What happens when the user pushes back on a Proposal
([issue #60](https://github.com/astefanovic/repcoach/issues/60)). The visual
design ([#43](https://github.com/astefanovic/repcoach/issues/43)) renders a
free-text channel as a peer of Accept on every Proposal — deliberately, because
the product's stance is that the coach is **interrogable rather than an
oracle** — but the behaviour behind it was unspecified. This ADR fixes it.

It does not re-litigate that coaching is ahead-of-time
([ADR 0002](0002-deliberation-pipeline-not-live-chat.md)), that Changes carry
origin and status ([ADR 0008](0008-plan-changes-carry-origin-and-status.md)),
or the run mechanics ([ADR 0011](0011-deliberation-internals-run-mechanics.md)) —
those bound the decisions below. It **amends ADR 0011 in three places**, called
out in §9.

It is also bounded by the information architecture settled in
[#42](https://github.com/astefanovic/repcoach/issues/42): this affordance
expands **in place on the Proposal card**, submitting does **not** navigate, and
there is **no chat destination, no thread view, no fifth chrome slot**. A
conversational destination would re-litigate ADR 0002 from the IA side. Every
decision below is shaped to fit inside a card.

## Decision

### 1. The affordance is **Revise**, and it ships in the first shell
The free-text channel is built alongside the Proposal card, not deferred and
not shipped inert. Cutting it was a live option — Accept/Dismiss is a complete
loop — and it was rejected on **data**, not on the design promise: a dismissed
Proposal records *that* the user declined; a revised one records *why*. That
prose is the highest-signal input the coach will ever get about the user's
preferences, and it is the seed material for Standing-constraint promotions
(§7). Cutting it would mean the first months of daily-driving produce a Decision
log full of unexplained rejections.

The label is **Revise**, not "Push back": it implies the *coach* does the
revising. "Modify" was considered and rejected — it reads as the user editing
the Proposal directly, the way a `user-direct` Plan edit auto-applies under
ADR 0008, which is not what happens here. The user does not change the Proposal;
they ask the coach to reconsider, and the coach decides. The input's placeholder
carries the rest of the scope ("ask a question, object, or request a change"),
since asking **why** without seeking a change is a first-class use (§2).

### 2. Output contract: one Answer, at most one revised Proposal
"Revised Proposal replacing the original" / "second Proposal alongside" / "plain
answer, original stands" is a false trichotomy — *the user's prose determines
which is correct*, and the user is not picking a mode:

- *"why 5 days?"* → an answer; the Proposal should stand untouched.
- *"not 5 days, I can't train more than 3"* → a revised Proposal.
- *"what else could I do?"* → either, depending on whether the coach actually
  changes its mind.

So the run cannot be told in advance which shape to emit. It emits **exactly one
Answer (prose, cited, always) plus at most one revised Proposal** — the revision
is optional and the agent's call:

- **Revision emitted** → the original flips to `superseded` (§3) and the revised
  Proposal becomes the new `pending` head on Today. One card, always.
- **No revision** → the original stays `pending` and the Answer appends to the
  card.

**Two pending Proposals side by side is rejected outright.** It hands the user a
decision the coach is supposed to have already made (ADR 0002 — the coach forms
an opinion, it does not present a menu) and doubles the pending surface on Today
for every Revise.

**The Decision log gets two rows either way, not one.** The Answer is itself a
`decision` row — immutable, cited, carrying its own Data window — because ADR
0002 holds that a Decision is never edited in place and amendments are new
Decisions. Even a "just answering your question" reply is a recorded coaching
determination with citations behind it. Revisions and the user's own prose
become part of the auditable story.

**A third `decision.kind`: `answer`.** Alongside `observation` and `proposal`. A
pure answer is neither — it proposes no Change and is not a standing "watching
this" finding. It also gives the Adversarial sweep something coherent to rewrite:
an Answer whose evidence collapses degrades to "reasoning only, uncited" exactly
as a Proposal does.

### 3. Supersession is the agent's judgment, the runner's authority
The agent may emit a **`supersede` directive**, but the **runner enforces
scope**: the directive is honoured only when the named id is (a) the Proposal
this run was invoked against and (b) still `pending`. Any other id is a
**no-op**.

ADR 0011 §5's "a directive naming a non-Observation id is a no-op" guard was not
protecting a semantic boundary — it was protecting against a *reasoning slip*: a
free-reasoning agent emitting a directive for an id it half-remembered from its
`sqlite3` dig, silently killing an unrelated pending Proposal, or flipping an
already-`accepted` one and desyncing the Plan from its own audit trail. Scoping
keeps that protection while allowing the judgment. The agent expresses intent;
the runner refuses to let it reach past its own subject.

Rationale for allowing it at all: **the agent and the user are doing the same
thing** — both are reviewers of a drafted Decision. Supersession being available
to either is coherent.

### 4. Sequential multi-turn, uncapped, one run in flight
The user may Revise again — including on a revised Proposal — but **only one
Revision run is in flight at a time**. Each run is seeded with the current
Proposal *and* the prior exchange on it, so the coach has continuity without the
app modelling a chat thread. The card renders the exchange as an **appended list
of turns** (prose blocks with the same cited-summary treatment as everything
else), older turns collapsed — never a bubble transcript.

Single-shot was considered. A turn here is **a full Deliberation run** —
deliberator plus adversarial sweep, minutes not seconds, queueable behind quota
(ADR 0011 §8) — so a multi-turn exchange is not a conversation but a *sequence
of separate coaching Decisions*, each with its own Data window and citations,
each appending two rows to the log. It was still rejected: a single exchange
often does not converge (*"why 5 days?"* → answer → *"right, but I can't do 5"*),
and forcing that into one message means composing a question and an objection
simultaneously.

*Accepted cost, named consciously:* with no turn cap, a long argument with the
coach can consume real quota and defer a Session review. Accepted at personal
scale; watch it in practice rather than inventing a cap now.

### 5. The card locks; Cancel is the only escape
Submitting a Revise **locks the Proposal card behind a spinner**: no Accept, no
Dismiss, no second Revise until the run lands. This is deliberate — it makes the
state obvious and eliminates every mid-flight race (accept-while-revising, and
the orphaned-revision case that follows from it) rather than specifying
behaviour for each.

The spinner's label distinguishes **queued** from **running**, so the lock
explains itself. ADR 0011 §8's whole posture is surfacing the deferral queue
honestly rather than silently delaying, and a Revision run is the one run the
user is actively waiting on — the one place a silent queue reads as a broken
button.

**Cancel** is the single escape affordance on the locked card:
- run **queued** → dropped from the queue, card returns to normal;
- run **already running** → the result is abandoned; the runner commits nothing.

Either way **no rows are written**. Cancellation exists because the lock's
duration is bounded by *quota*, not by the run: on a low weekly rolling limit a
queued run can wait hours, and without an escape a pending Proposal becomes
permanently un-acceptable with no in-app recovery — a hard-stuck state in the one
surface that mutates the Plan.

A leave-and-return model (no lock, Accept/Dismiss live throughout) was
considered and rejected in favour of the simpler locked contract.

### 6. Not a fourth config — a third prompt framing on the same runner
A Revision run is **the Session-review runner with a different prompt framing**,
extending ADR 0011 §4's "one mechanism, two framings" by one. Same seed shape,
same read-only snapshot, same native `sqlite3`/web tool access, same Adversarial
sweep, **same configured model** (no third model selector in settings). The only
additions to the seed are the **target Decision in full** (summary, rationale,
citations, Data window) and the **prior exchange turns**.

A lean amendment run — seeded with just the Decision and the user's text, no DB
access — was rejected. The most common Revise is *an argument about the data*:
*"I didn't stall on those reps, I was sick that week"* is a claim the coach can
only evaluate by going back to the Log and the Check-ins. A run that can only
re-read its own rationale would restate its reasoning more politely instead of
re-examining it — precisely the live chatbot ADR 0002 rejects.

The **Adversarial sweep always runs.** ADR 0011 §8 already forbids skipping it
to save budget (a run that cannot afford it defers); beyond that, a revised
Proposal that skipped verification would be a strictly *lower-trust* artifact
than the one it supersedes, inverting the point of the sweep.

`data_window_json.cadence` takes a distinct value for Revision runs. This is a
**log-provenance label only**, not a mechanism difference — but "was this raised,
or was it argued into existence?" is a question the Decision log must be able to
answer.

### 7. Output scoping: asymmetric, runner-enforced
A Revision run digs through the Log to answer its question and will notice
unrelated things. The runner scopes what survives:

| Emission | Fate |
|---|---|
| The Answer | committed |
| One revised Proposal | committed (supersedes the target, §3) |
| Any **other** new Proposal | **discarded** |
| New **Observations** | **kept, forced `surface: false`** |
| Observation directives on **unrelated** ids | **discarded** |

- *Other Proposals discarded:* the user asked one question about one Decision;
  getting two unrelated Plan changes back is the coach changing the subject
  mid-argument. If the dig genuinely found something Proposal-worthy, the next
  Session review will find it too — that is what the Observation mechanism is
  for.
- *Observations kept but unsurfaced:* they land as `open` Observations and become
  evidence for future runs, so the dig is not wasted — but asking a question
  must not spawn unread feed items.
- *Unrelated directives discarded:* same reasoning as §3's scoped `supersede`.

**This is a structural lane and it contradicts ADR 0011 §4's stated posture**
("both cadences may propose anything; no structural emission lanes"). Recorded
explicitly so a future reader does not read it as §4 quietly eroding: **§4
governs proactive *survey* cadences**, whose job is to range over the data. A
Revision run is **user-invoked and has a subject**. Scoping it is about the run
staying on topic, not about restraining twitchiness — the anti-twitchy guarantee
still rests entirely on the Observation mechanism plus the sweep.

### 8. Standing-constraint promotion folds *into* the revision
*"Not 5 days, I can't train more than 3"* is not an objection to one Proposal —
it is a **Standing constraint** stated in passing. A Revision run may therefore
propose a constraint promotion, but **only inside its revised Proposal**, never
as a separate emission (§7 forbids the latter anyway, and it would put two
pending Proposals on Today against §2).

So the revision reads: *"3 days instead of 5, and I'd like to record 'max 3
training days' as a standing constraint — accept both?"* One card, one Accept,
both effects. Wanting the schedule change without the standing rule is itself a
further Revise.

- *Why capture it here rather than let a later review notice the pattern:* the
  constraint is only legible **in the sentence the user typed**. A Session review
  reading the log later sees a superseded Proposal and a revision, and must
  reverse-engineer the rule from them. Capturing it at the moment it was said is
  strictly better evidence.
- *Why inside the revision rather than beside it:* promotion is a real
  Plan-adjacent commitment and must not be something the coach slips in while
  answering a question.

*Required of the UI:* a single Accept that installs a durable rule the user will
be governed by for months **must be stated plainly on the card**. Silently
bundling it is exactly the kind of thing that erodes trust in the coach.

### 9. Proposal lineage: the exchange belongs to the chain, not the row
§2 replaces the original on Today; §4 appends turns to the card. Those collide —
the turns are attached to a row that just left Today. Resolution: **the exchange
belongs to the lineage.**

The revised Proposal's card carries the whole history: the user's Revise prose,
the coach's Answers, and a collapsed "previous version" entry per superseded
Proposal — everything but the current turn collapsed by default. A Proposal card
renders `[current Proposal] + [collapsed history of the chain that produced it]`,
walking back through `superseded` rows. **Coach** shows the flat immutable truth:
every row, in order, nothing collapsed.

The alternative — revision arrives as a clean card, exchange left behind in Coach
— was rejected: a revised Proposal is only comprehensible in light of the
objection that produced it (*"3 days instead of 5"* with no visible reason is
worse than the original), and it would put the one place the coach responded
directly behind a navigation.

*Required of the data:* each Decision row carries a **link to the row it
superseded** (or the exchange carries a shared chain id). Cheap, and it is what
makes #42's "the prior version reachable in Coach" mechanically possible at all
rather than a full-log scan.

## Amendments to ADR 0011

1. **§4 (no structural lanes)** — now reads as governing *proactive survey
   cadences*. A Revision run is user-invoked, subject-scoped, and its emissions
   are filtered by the runner (§7 above).
2. **§5 (`superseded` reserved; non-Observation directives are no-ops)** —
   `superseded` is now reachable two ways: Change supersession under ADR 0008,
   and a **scoped `supersede` directive** on the Proposal a Revision run was
   invoked against (§3 above). The no-op guard survives for every other id.
3. **§7 / the three-config list** — Deliberation now has **three prompt framings
   on the review runner** (Session review, Cycle review, Revision run) plus the
   distinct interactive Intake configuration.

## Considered Options

- **Cut Revise from the first shell** (ship Accept/Dismiss only, file it as a
  post-daily-drive ticket, optionally let Dismiss carry a one-line reason).
  Rejected per §1 — but the "Dismiss with an optional reason" idea is left
  undecided and remains cheap to add for the "no, and I'm not arguing" case.
- **A second Proposal alongside the original.** Rejected (§2): presents a menu
  where the coach is supposed to hold an opinion.
- **Single-shot exchange.** Rejected (§4): does not converge.
- **Leave-and-return with Accept/Dismiss live mid-flight.** Rejected (§5) in
  favour of the simpler locked card.
- **Absolute lock with no escape / a lock that merely expires.** Rejected (§5):
  the first can strand a Proposal permanently; the second is a weaker version of
  Cancel.
- **A distinct fourth run configuration with its own model selector.** Rejected
  (§6): the flow is a Session review's, so it should *be* one.
- **A lean amendment run with no DB access.** Rejected (§6): it could not
  evaluate an argument about the data.
- **Unscoped emissions, per ADR 0011 §4.** Rejected (§7): a user-invoked run must
  stay on its subject.
- **A separate constraint-promotion Proposal alongside the revision.** Rejected
  (§8): two pending Proposals.
- **Exchange left in Coach, clean revised card on Today.** Rejected (§9):
  a revision without its objection is less comprehensible than the original.
- **A conversational destination / thread view for the exchange.** Foreclosed by
  [#42](https://github.com/astefanovic/repcoach/issues/42) and ADR 0002; that
  conclusion would reopen #42 rather than being absorbed here.

## Settled while building the store seam

Three details the design above did not pin down, decided during the
persistence implementation and recorded here so the ADR matches the code:

- **An Answer is born `status='answered'`** — a terminal status of its own. It
  is not `pending` (there is nothing to accept) and not `open` (it is not an
  Observation accumulating toward a trend).
- **An Answer never gets a `coaching_feed_entry`**, regardless of its `surface`
  flag. It is already on the card the user is looking at; manufacturing an
  unread feed item for a reply the user asked for would be noise.
- **§7's scoping is enforced in the store, not only in the runner.** The store
  is the trust boundary over an untrusted agent output (ADR 0011 §3), so the
  same place that already refuses out-of-scope Observation directives refuses
  extra Proposals, surfaced Observations, and out-of-subject `supersede`s. A
  Revision run is identified by the presence of `reviseTargetProposalId`, which
  only the runner can supply.

The lineage link is one column, `decision.in_response_to_id`, not two: "which
row superseded this Proposal?" is the `kind='proposal'` row pointing at it, so a
separate `supersedes_id` would be a second copy of one fact.

## Consequences

- **New `decision.kind = 'answer'`** and a **supersedes-link** on `decision` —
  both schema changes, both required before the Proposal card ships.
- **The runner grows a scope filter** (§3, §7) and a **cancellation path** (§5).
  The existing ADR 0011 §5 no-op guard and its adversarial suite stay valid and
  gain the scoped-`supersede` case.
- **The Proposal card is now the app's most complex surface**: current Proposal,
  actions, an appended exchange, collapsed lineage, a lock state, and a Cancel.
  It remains one card in one column on Today — #42's constraint held.
- **Deliberation cost per Proposal is now unbounded** (§4). The first thing to
  watch when daily-driving — tracked as
  [UAT watchlist §1](../design/uat-watchlist.md), which also carries the open
  question of whether a Revise should collapse into a plain thread of context on
  the Proposal. **Unbounded, and until
  [#81](https://github.com/astefanovic/repcoach/issues/81) also unmeasured** —
  the entry's first question is *tokens per Revision run vs a Session review*,
  and nothing persisted per-run cost, so the comparison could not be made. The
  run ledger ([ADR 0011](0011-deliberation-internals-run-mechanics.md) §8) is
  what makes it answerable; note a Revision run is two agent sessions (draft +
  sweep) like any other, so the comparison is fair only now that the sweep is
  counted.
- **Accept can now do two things** (§8), which places a real disclosure burden on
  the card.
- **CONTEXT.md gains** `Revise`, `Revision run`, `Answer`, `Proposal lineage`;
  `Proposal`, `Decision` and `Deliberation run` are sharpened.
