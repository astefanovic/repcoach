# Intake: one held-open run, swept once, accepted as the first Proposal

What the Intake takeover looks and behaves like end to end
([issue #64](https://github.com/astefanovic/repcoach/issues/64)). Intake is the
only surface the information-architecture grilling
([#42](https://github.com/astefanovic/repcoach/issues/42)) left substantially
unspecified, and it is the very first thing a cold user sees.

It does not re-litigate what is already fixed. From #42: Intake is a **one-time
takeover** entered from Today's empty state and not a destination; it is
**chrome-free** (no nav, no status strip — the prototype's `ModeShell` already
renders with the strip omitted); it is **abandonable**, discarding the draft and
returning to the no-Plan empty state, with Plan view's own empty state as the
standing manual alternative; its route is `/intake`. From
[ADR 0011](0011-deliberation-internals-run-mechanics.md) §7: Intake is the *one*
interactive Deliberation run, seeded with the structured form plus the raw Goal,
and it emits the first Plan as an accept-able Proposal. From
[ADR 0002](0002-deliberation-pipeline-not-live-chat.md): it amends a **drafted**
Decision rather than originating coaching from a blank slate.

It **amends ADR 0011 in two places**, called out in §9.

## Decision

### 1. The form asks only what a model cannot guess

One scrolling form, four fields, no wizard and no paced multi-step sequence:

- **Goal** — one free-text line, deliberately un-validated ("get stronger",
  "put on size"). Sharpening it into measured targets is the coach's job
  (CONTEXT → **Goal**), so demanding precision here would be asking the user to
  do the thing they came for.
- **Days/week** — a stepper or 2–6 chips. One tap.
- **Equipment** — a small chip multi-select (full gym / dumbbells / barbell +
  rack / machines / bodyweight only), not an inventory checklist.
- **Lifts + current working weights** — the only heavy field, and **skippable**.
  "I haven't been training" is a common and honest answer; when the field is
  absent the agent treats starting loads as one of its judgment calls, which is
  exactly what ADR 0011 §7 puts it there for.

Submit is gated on Goal and days/week only; everything else is optional.

The rule the field set follows: **the form spends the user's patience on facts
an LLM cannot guess, and nothing else.** The moment a question requires
judgment, it belongs in the interactive pass (§2), where the agent can ask it
*about a concrete draft* rather than in the abstract — a far better question and
a far easier answer.

A paced wizard with progress dots was rejected. It reads as more polished, but
it front-loads ceremony onto a surface whose entire pitch is "the coach does the
thinking", and Intake is abandonable with no partial save — so a long form makes
walking away more likely, not less.

### 2. Intake is **one run with many turns**; Revise is **N runs of one turn each**

This is the load-bearing distinction, and it is what keeps the interactive pass
from becoming either a chatbot or an unaffordable one.

The obvious move was to reuse **Revise** ([ADR 0013](0013-revise-user-invoked-amendment-of-a-drafted-decision.md))
wholesale: the user's Intake back-and-forth (missing equipment, exercise
preferences, objections to the structure, sharpening the Goal) *is* structurally
"user objects to a drafted Decision, coach re-deliberates". It was rejected
because the reasoning that made a Revision run heavy is **vacuous at cold
start**. ADR 0013 seeds a Revision run with the full Session-review context
specifically so the coach can re-read the Log and Check-ins to settle an
argument about data — *"I didn't stall, I was sick that week."* At Intake there
is no Log, no Check-in, no analytics and no prior Decision. The database is
empty by definition. A full re-seeded, separately-swept run per turn would be
re-reading nothing, expensively, several times.

So:

- **The Intake deliberator session is held open across the exchange** and
  resumed turn to turn, carrying its own context forward. Turns are cheap:
  no per-turn re-seed, no per-turn Adversarial sweep, no per-turn Decision row,
  no per-turn lock-with-Cancel ceremony.
- **The Adversarial sweep runs exactly once**, at convergence (§5), over the
  final Plan and every citation it accumulated. This is not a relaxation of
  ADR 0011 — §7 already said the sweep "still runs on **the final plan**". It
  never said per turn.
- **Interim turns write nothing.** Nothing reaches the Decision log until
  convergence. Intake produces **one** Decision, as ADR 0011 §7 specifies.

**The coach asks questions back.** In a Revision run the user opens every turn;
at cold start it is the *coach* that holds the missing information ("dumbbells
only — no bench either?", "stronger at what?"). The Intake framing therefore
permits the coach's turn to carry open questions, rendered as a short block
attached to the draft, with **quick-reply chips** where the answer is a closed
set. A chip is an answer, not a second channel: tapping it submits the same turn
it would have typed.

**ADR 0013 is deliberately untouched.** Rewriting Revise into a lightweight
thread-appending channel is a real option and was raised, but it is a separate
decision with its own consequences — outside Intake, an unswept revised Proposal
is a strictly lower-trust artifact than the one it supersedes, and that argument
still stands. Folding it into #64 would let an Intake finding silently rewrite
the Proposal card. The asymmetry is recorded here as a decision rather than left
to read as an inconsistency: **turns are cheap where there is no data to
re-examine, and heavy where there is.**

### 3. Interim citations are shown, marked provisional

Cheap turns have a price: an unswept turn can make claims no verification has
touched. If the coach says mid-exchange that "weekly volume drives hypertrophy
more than frequency", no source has been fetched and no trust level assigned,
where the same sentence on a Proposal card would carry a badge.

Citations are **kept** in interim prose and **marked provisional**, with a
tooltip stating that every source is verified when the plan is reviewed (§5).
Stripping them was considered and rejected: it would hide the coach's reasoning
at the exact moment the user is deciding whether to argue with it. Marking them
turns the pending sweep into a **visible promise** rather than a backstage step,
and the promise is discharged in public on the final card (§5).

### 4. Waiting: two different waits, and no queue

The takeover has no status strip, so run state, spend and failure need homes.
There are two waits and they are not alike.

- **The cold wait** — form submitted, nothing on screen, a whole Plan being
  drafted with web retrieval. The worst moment in the app. The form **collapses
  into a compact one-line summary** ("4 days · dumbbells + rack · squat 100,
  bench 70") which stays pinned for the rest of Intake as the thing the plan is
  answering to. Below it, a **live activity line driven by real tool events**
  ("reading up on training frequency", "drafting session 2 of 4") — not a staged
  fake progress bar. This surface's personality is *the working is the UI*
  (#43's coach output); a bare spinner would be the one place the app pretends
  there is nothing to see.
- **The turn wait** is gentle: the draft stays on screen, the input disables, a
  quiet pending line sits under it. No lock ceremony and no per-turn Cancel —
  Cancel here means abandoning Intake, which is already free (§7).
- **Spend** gets one quiet provenance footer at the bottom of the takeover, same
  idiom as the coach output footer (`intake · model · N.Nk tokens`),
  accumulating across the session. A home without inventing chrome.
  > **Corrected by [#81](https://github.com/astefanovic/repcoach/issues/81).**
  > The footer was counting the SDK's `input_tokens`, which is the *uncached*
  > input only — so it understated every turn, and understated this surface
  > worst of all, since a held-open session is precisely where cache reads
  > dominate. The footer named the mitigation for an uncapped exchange while
  > quietly reporting a fraction of it. Fixed by widening token usage to four
  > fields (see [ADR 0011](0011-deliberation-internals-run-mechanics.md) §8).
  > The footer stays session-scoped and client-accumulated for the reason given
  > above — usage is reported per returned run, and a counter ticking during a
  > run it cannot measure would be a second lie. Cross-session history lives in
  > the run ledger, not here.

**Intake is exempt from the deferral queue.** ADR 0011 §8 defers a
quota-starved run on the explicit grounds that *"Deliberation is ahead-of-time
and proactive, so nothing is user-blocking."* **Intake is the counterexample** —
the only user-blocking run in the app, and the first thing a cold user ever
does. Queuing it tells a brand-new user to come back later, and since abandoning
discards the draft, "later" means "start over". A quota-starved Intake therefore
**fails loudly**: it says so in plain language, offers a retry, and points at
Plan view's empty state as the manual path that needs no agent at all. An
honest failure is actionable; a queue position is not.

### 5. Convergence is a separate act from acceptance, and the sweep sits between

Putting the sweep behind **Accept** would mean the user accepts a plan whose
citations have not been checked, after which the sweep rewrites the rationale
underneath a Decision they already agreed to — possibly stripping the very
source that convinced them. That inverts the trust model: under ADR 0011 the
sweep's output **is** the committed Decision, so its output must be the thing
the user is shown, not the thing they get afterwards.

So finishing and accepting are two acts:

1. **"Review the sources"** ends the exchange and fires the single sweep. The
   second and last wait, and the one worth showing — *"the coach verifies every
   citation behind this plan"* is the most trust-building sentence the app will
   ever display, and it is true. The label was chosen over bare "Review"
   (ambiguous about who is reviewing, and colliding with the named **Session
   review** / **Cycle review** cadences) and over "Check the sources"; it names
   the stage and the actor.
2. The swept output renders as the **real Proposal card** — layered summary,
   expandable evidence, Citations with genuine `corpus-verified` /
   `retrieved-unverified` badges, Data window — and it **discloses its own
   edits**. "Two sources didn't hold up and were removed" is not an
   embarrassment; it is the feature working in public, on the exact surface
   where the user is deciding whether to trust the thing at all. The provisional
   marking from §3 is discharged here.
3. **The sweep governs the justification, never the prescription.** The sets and
   reps are what the user converged on and are not rewritten under them.
4. **Accept** then does the ordinary thing (§6).

The exchange stays reopenable from the final card; another turn resumes the
session, and finishing again re-sweeps.

### 6. The handoff, and why it is the ordinary Proposal card

Accept commits the Decision, applies the Change as `coach-proposal`
accepted→applied ([ADR 0008](0008-plan-changes-carry-origin-and-status.md)),
brings the Plan into existence, and exits the takeover to a **populated Today**
with the chrome restored.

The card is genuinely the **same** Proposal card used everywhere else, despite
that card otherwise being a Coach artifact. A user who accepts their first plan
there has just been taught how every future coach Proposal reads — Intake
doubles as the tutorial for the card they will meet on Today forever. Two
divergences, both forced by cold start:

- An ordinary Proposal renders a **diff against the standing Plan**; here there
  is no prior Plan, so the payload is the whole Plan rendered as itself.
- It is **never pending on Today and never in the Coach badge** — it is decided
  in place, before Today is ever populated.

### 7. The Calibration-phase message arrives with the draft, not before the form

ADR 0011 §7 already fixes that the caveat is stated in the first Decision. Its
placement in the takeover:

- **Not before the form.** Expectation-setting shown to someone who has not seen
  anything yet is text they scroll past. The caveat only means something once
  there is a concrete plan to be caveated.
- **Not a dismissable toast or modal.** It is the honest-disclosure principle,
  which is the product's differentiator; putting it behind an "OK" is the single
  treatment that contradicts its own content.
- **A short framed note under the plan hero in the first draft turn**, in the
  coach's voice: this first block is more template than coaching because there
  is no performance data yet, it becomes real once roughly a mesocycle is
  logged, and here is specifically what changes then. **Naming what unlocks is
  what turns a disclaimer into a promise.**
- It **survives into the accepted Decision**, so it stays permanently readable
  in Coach and the Decision log beside the plan it qualifies.

**Nothing persistent lands on Today.** A banner that sits there for a month
becomes wallpaper, Today is settled surface (#42/#43), and the honest signal is
better carried by the coach's output being visibly thinner in that period than
by chrome asserting it. Whether calibration deserves any post-Intake presence is
handed forward, not annexed here.

### 8. Failure, abandonment, and the absence of an empty state

- **Offline / home server unreachable.** Intake is the one flow that cannot
  degrade gracefully — the app is local-first but there is no local coach. So
  Today's empty state must not dangle an invitation that dead-ends: when the
  server is unreachable it says so and routes to Plan view's manual empty state,
  which #42 already established as the standing alternative.
- **Cold draft fails.** The form returns **with its values intact**, plus a
  plain statement and a Retry. Losing the weights the user just typed is the one
  unforgivable version of this.
- **A turn fails.** The draft is the valuable thing and stays on screen; the
  failure reports itself inline under the input. Because interim turns write
  nothing (§2), a failed turn is a genuine no-op — there is no half-applied
  state to reconcile.
- **The sweep fails to run.** No Proposal is offered. An unverified plan cannot
  be accepted and the sweep is never skipped (ADR 0011 §8). Retry, or keep
  tweaking.
- **The sweep guts the plan.** *Not* an error — the machinery working. The
  prescription stands, the rationale is thinner, the card states which sources
  did not hold and which points are now "reasoning only, uncited", and the user
  **can still accept it**. Honest disclosure means deciding *with* that
  knowledge, not being protected from it.
- **Abandonment** follows #42's rule — draft discarded, back to the no-Plan
  empty state — with one refinement: **confirm only when there is something to
  lose.** Backing out of an untouched form is free and silent; backing out with
  a draft asks once and says plainly that the draft is gone.
- **Reload or tab close mid-Intake** is the same as abandonment: the session
  dies, the draft is gone. No draft persistence and no session resurrection — it
  is consistent with abandonability, and it stops a one-time cold-start flow
  from growing a recovery subsystem it would exercise approximately once.
- **There is no Intake empty state**, by construction: the form is the entry and
  Intake only exists when there is no Plan. Stated so nobody designs one.

### 9. Amendments to ADR 0011

- **§7 (Intake is a distinct, interactive cold-start run)** — the interactive
  shape is now specified: **one held-open deliberator session resumed across
  turns**, not a sequence of runs; **one Adversarial sweep at convergence**, not
  per turn; **no Decision rows until convergence**; and convergence
  ("Review the sources") is a **separate act from Accept**, with the swept
  output being what the user accepts.
- **§8 (deferral only)** — "nothing is user-blocking" becomes "nothing among the
  three fire-and-forget cadences is user-blocking". **Intake is exempt from the
  deferral queue and fails loudly instead** (§4).

## Considered Options

- **Reuse Revise wholesale as the interactive pass.** Rejected (§2): its heavy
  seed exists to re-examine Log data that does not exist at cold start.
- **A bespoke free-running Intake chat that emits the Plan only at the end.**
  Rejected: it is the "chatbot guessing" shape ADR 0002 was written to prevent,
  it has no runner-enforced scope, and an abandoned Intake would record nothing.
- **Rewriting Revise itself into a lightweight thread-appending channel.**
  A live option, deliberately deferred (§2) rather than decided as a side effect
  of an Intake ticket.
- **Sweeping every turn.** Rejected (§2): verification of nothing, repeatedly,
  against a subscription quota.
- **Stripping citations from interim prose.** Rejected (§3): hides the coach's
  reasoning exactly when the user is deciding whether to argue with it.
- **A paced multi-step form wizard.** Rejected (§1): ceremony in front of the
  one surface whose pitch is that the coach does the thinking.
- **Queuing a quota-starved Intake like every other run.** Rejected (§4):
  a queue position is not actionable for a blocking, abandonable cold start.
- **Accept as the single action, sweep behind it.** Rejected (§5): the user
  would accept an unverified plan and have its rationale rewritten underneath.
- **A distinct Intake-only result card rather than the Proposal card.**
  Rejected (§6): the shared card makes Intake the tutorial for every future
  Proposal.
- **A persistent calibration banner on Today.** Rejected (§7) and handed
  forward.
- **Persisting the draft across reload.** Rejected (§8): a recovery subsystem
  for a flow that runs once.

## Consequences

- **The runner grows a held-open interactive session** — a mode neither review
  cadence needs: resumable turns, a terminal convergence step, and a sweep
  fired by the client rather than by run completion.
- **Turn-level events must reach the client** (§4's activity line), which the
  fire-and-forget cadences never required.
- **Intake bypasses the quota queue**, so quota exhaustion is now a
  user-visible, user-blocking state with its own copy.
- **The Proposal card gains two cold-start modes**: whole-Plan payload instead
  of a diff, and a "what the sweep changed" disclosure. The disclosure is worth
  generalizing to every Proposal later, but is only *required* here.
- **One Decision, written once**, keeps Intake's store contract trivial — no
  interim rows, no cleanup on abandonment.
- **Abandonment is genuinely free** at every point, which is what allows the
  form to stay short and the exchange to stay uncapped.
- **The exchange is uncapped in both turns and spend**, knowingly and without
  evidence — the provenance footer (§4) is the whole mitigation. Recorded as
  [UAT watchlist entry 2](../design/uat-watchlist.md); the named risk is an
  Intake that exhausts quota mid-exchange, where failing loudly costs the user
  the draft. **The mitigation is now two things, not one**
  ([#81](https://github.com/astefanovic/repcoach/issues/81)): the footer, which
  shows the exchange in front of you and is only truthful after the four-field
  correction above, and the run ledger, which persists per-session cost and is
  what actually settles the entry's question — *cold-draft tokens vs per-turn
  tokens* is a comparison between rows, and the footer never held rows.
- **The revision ledger's line is derived, not carried.** §2 puts one open
  question on screen and folds answered turns into "what changed about the
  plan", but the turn payload says only what the draft *is* — so the client
  diffs consecutive drafts to produce that line. Adding a `changed` string the
  coach writes was the alternative and was not taken: it asks the coach to
  narrate its own edit, which it can do wrongly, where a diff cannot. Recorded
  as [UAT watchlist entry 3](../design/uat-watchlist.md); the named risk is a
  coach that renames a session reading as replacing it.
- **CONTEXT.md sharpens** `Intake`; `Calibration phase` gains its placement.
