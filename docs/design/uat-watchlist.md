# UAT watchlist — decisions to judge on the running app

Design decisions made **knowingly, without evidence**, that can only be settled
by daily-driving the app. Not a test plan: the three automated rungs
(`docs/agents/testing.md`) prove the app does what it was built to do. This list
asks a different question — **was it worth building that way?**

Entries land here from grilling sessions: whenever a branch is resolved by taking
the expensive or permissive option and accepting a named risk, that risk becomes
an entry, cross-referenced from the resolving ADR's *Consequences*.

Each entry keeps the same shape so it stays skimmable:

- **The question** — one line, the thing you are actually judging.
- **Watch for** — the observable signals, nothing subjective-only.
- **If it bites** — two pre-planned fallbacks. An entry without them turns a bad
  UAT result into a fresh grilling session instead of an afternoon's work.
- **The bigger question** — present only when the honest answer might be "the
  concept is wrong", not "the setting is wrong".

Newest at the bottom; numbers are never reused, so an ADR can cite an entry
number without churn.

**Status:** ⬜ not observed · 🟡 watching · 🟢 fine as built · 🔴 needs the fallback

---

## 1. ⬜ Revise: too many tokens?

> **The question:** a Revise fires a *full* Deliberation run — full seed, DB dig,
> Adversarial sweep — and turns are uncapped. Is that worth it, or should it be
> lean?

[ADR 0013](../adr/0013-revise-user-invoked-amendment-of-a-drafted-decision.md)
§6/§4 · [#60](https://github.com/astefanovic/repcoach/issues/60)

The lean version was rejected because the most common Revise is *an argument
about the data* (*"I wasn't stalling, I was ill that week"*), which needs the Log
and Check-ins. Nobody knows the real mix of prose yet.

**Watch for**

- Tokens per Revision run vs. a Session review. Roughly equal is expected.
  Read this off the **run ledger** ([#81](https://github.com/astefanovic/repcoach/issues/81)) —
  Settings shows a per-cadence breakdown plus recent runs. Compare *runs*, not
  the cadence totals: a total confounds "revisions are expensive" with
  "there were a lot of revisions".
- Lineage depth — turns to converge. One means single-shot would have done.
- **Did a Revise ever defer a real review?** The named risk. 🟡 → 🔴.
- Did the dig ever change the answer? If Answers only ever cite what the seed
  already held, the DB access is dead weight.

**If it bites**

1. **Lean follow-up turns** — turn 1 digs, turns 2+ reuse it. Most likely right
   answer; no ADR change (§6 fixes the run's shape, not that every turn matches).
2. **Cap turns** — rejected up front as premature; a real quota collision is the
   evidence. Amends §4.

Floors either way: Standing constraints stay injected (ADR 0011 §2), the sweep is
never skipped (ADR 0011 §8).

**The bigger question — should a Revise just be a thread of context on the
Proposal?**

Not a fallback, a refactor. Drop the `answer` kind, the lineage link, the scoped
`supersede`, the three-shapes contract: the Proposal simply accrues turns. Most
of ADR 0013's machinery goes, and the card stops being the app's most complex
surface.

Justified if all three hold after real use: Answers are rarely cited, exchanges
rarely produce a revision, and you never re-read an Answer in the log. Killed by
one occasion of going back to an old Answer and being glad it had citations and a
Data window.

**This is an ADR 0002 conversation, not an ADR 0013 one.** A thread has nowhere
to run the sweep, and a Proposal that mutates in place is the edited Decision
ADR 0002 forbids. Grill it there.

---

## 2. ⬜ Intake: an uncapped exchange, once per lifetime

> **The question:** neither the number of Intake turns nor the total spend is
> capped, and the only mitigation is a footer showing what it cost. Is that fine
> for a flow that runs once, or does the one user-blocking run in the app need a
> guard?

[ADR 0014](../adr/0014-intake-one-held-open-run-swept-once.md) §2/§4 ·
[#70](https://github.com/astefanovic/repcoach/issues/70)

Capping was rejected as premature by two grillings. The reasoning: turns are
cheap by construction (no re-seed, no per-turn sweep, no Decision row), the flow
runs approximately once per user, and abandoning discards the draft — so a cap
that fires mid-exchange costs the user everything and saves very little. The cold
draft plus one sweep is expected to dominate; nobody has measured it.

**Watch for**

- Cold-draft tokens vs. per-turn tokens. A turn being a visible fraction is the
  claim; roughly equal means the held session is not buying what it should.
  The **run ledger** ([#81](https://github.com/astefanovic/repcoach/issues/81))
  carries one row per agent session with a stage discriminator, so draft, turns
  and sweep are separable — which is the only shape this question can be asked
  in. Note the pre-#81 footer understated all of these (uncached input only,
  worst on exactly this surface), so **any figure eyeballed before that fix is
  not a baseline.**
- Turns to converge. Two or three is the design; ten means the form asked too
  little, not that turns need capping.
- **Did an Intake ever exhaust quota mid-exchange?** The named risk — it fails
  loudly and the draft is gone, which is the worst moment in the app to hit.
  🟡 → 🔴.
- Whether the spend footer was ever actually read, or is chrome nobody looks at.

**If it bites**

1. **Soft warning at N turns** — the coach says the exchange is getting
   expensive and offers to converge. No ADR change; §2's "no cap" is about the
   app not stopping the user, not about staying silent.
2. **Hard turn cap** — amends §2, and only worth it against a real quota
   collision rather than a large-looking number.

Floors either way: the sweep is never skipped to save budget (ADR 0011 §8), and
Intake never joins the deferral queue (§4) — a queue position is not actionable
for an abandonable cold start.

---

## 3. ⬜ Intake: is a *derived* revision ledger readable?

> **The question:** the ledger line is "what the answer did to the plan", and
> nothing on the wire says what that was — the client derives it by diffing
> consecutive drafts. Does a machine-written changelog line read like a
> changelog, or like a diff?

[ADR 0014](../adr/0014-intake-one-held-open-run-swept-once.md) §2 ·
`ui-surfaces.md` → Intake (*Settled by the prototype*) ·
[#74](https://github.com/astefanovic/repcoach/issues/74)

The #64 prototype hand-wrote those lines ("Lower back → RDLs out, hip thrust and
leg curl in") and they carried the whole not-a-chat argument. Real turns carry
the draft and nothing about how it differs, so the line is now derived
(`intake/ledger.ts`). Adding a "what changed" field to `IntakeTurn` was the
alternative and was **not** taken: it asks the coach to narrate its own edit,
which it can do wrongly, where a diff cannot.

**Watch for**

- Does the collapsed header line ever read as gibberish — three clauses, a
  renamed session, a headline rewrite that swamps the real change?
- **Did a turn that clearly changed the plan produce "the plan is unchanged"?**
  The named risk: the diff is keyed on session `label` and exercise name, so a
  coach that renames things reads as replacing them. 🟡 → 🔴.
- Was the ledger ever expanded at all, or is the collapsed one-liner enough?

**If it bites**

1. **Narrow the diff** — match sessions positionally rather than by label, and
   fall back to the headline when a session is renamed wholesale. Local to
   `intake/ledger.ts`, no contract change.
2. **Put the line on the turn** — `IntakeTurn` gains a `changed` string the
   coach writes, with the derived line as the fallback when it is absent.
   Amends #70's payload; only worth it if the derivation is *usually* wrong
   rather than occasionally clumsy.

Floors either way: the user's own answer stays subordinate to the consequence
(that inversion is the not-a-chat argument), and an unchanged plan is *stated*
rather than rendered as a blank row.

---

## 4. ⬜ One outbox, two command kinds — does it stay coherent?

> **The question:** #80 widened the outbox from "queued logged Sets" to "queued
> commands", so a Plan edit and a logged Set now share one queue, one drain and
> one pending count. Is one general queue the right shape, or was the logging
> outbox better off staying a logging outbox?

[ADR 0015](../adr/0015-plan-authoring-is-one-operation-union.md) *Consequences* ·
[#80](https://github.com/astefanovic/repcoach/issues/80)

The alternative — option B, gate the editor on connectivity and keep the direct
RPC — was rejected because it left Plan edits genuinely lossy in a dead spot,
which is the same class of failure as losing a Set. That reasoning still looks
right. What was taken on faith is that **one queue generalises cleanly**: the
manager and storage never knew what they carried, the flusher branches on `kind`
in exactly one place, and nothing else learned the difference. That is a claim
about a codebase with *two* command kinds in it, made before there was a third.

**Watch for**

- **Does the strip's bare count stay honest?** It deliberately dropped its noun
  ("3 sets pending" → "3 pending") because a Plan edit is not a set. If you ever
  look at a non-zero count mid-session and cannot guess what is in it, the count
  has stopped being reassurance and become noise. 🟡 → 🔴.
- Does anything ever want to drain the two kinds at *different* priorities — a
  logged Set held up behind a Plan edit mid-workout, or vice versa? The drain is
  strictly one ordered queue, deliberately, because Plan operations depend on
  order. Wanting to overtake is the signal the single queue is wrong.
- **Does a rejected Plan edit ever actually surface?** The rejection channel
  (`OutboxManager.rejections`) exists for a case that should be near-impossible:
  the local validator and the server run the same function. If it fires in real
  use, the two sides have drifted and that is the finding, not the wording.
- Does a third command kind ever want to join, and does adding it stay a
  one-file change?

**If it bites**

1. **Give the count its noun back** — the strip reads the queue's kinds and says
   "2 sets · 1 edit". Local to `statusStrip.ts`; costs strip width, which is why
   it was not done first.
2. **Split the queues** — a separate manager instance per command kind over the
   same storage seam, drained by separate flushers. The seam already supports it
   (`makeOutboxManager` takes storage as a parameter and holds no global state),
   so this is a wiring change, not a redesign. Only worth it if priorities
   genuinely need to differ — it gives up the cross-kind ordering guarantee.

**The bigger question:** if a third kind arrives and the flusher's `kind` branch
starts carrying real per-kind logic rather than one RPC call each, the queue has
become a dispatcher and the generalisation has stopped paying. At that point the
honest move is per-kind flushers over a shared durable log, not more branches.

---

## 5. ⬜ A 30-day Cycle review that claims before it runs

> **The question:** the Cycle review fires on a fixed 30-day interval measured
> from the last fire, and the schedule is marked used *before* the run starts.
> Is a rolling 30 days the right beat for a review whose whole framing is "weigh
> the longer history" — and is silently losing a month to a failed run
> acceptable?

[ADR 0011](../adr/0011-deliberation-internals-two-agent-thin-context.md) §4 ·
[#91](https://github.com/astefanovic/repcoach/issues/91)

Two things were decided on reasoning alone. **The beat:** 30 days rather than
calendar months, because the review is indifferent to landing on the 28th or the
31st and a fixed interval has no month-length edge cases. But it *rolls* — a
review that fires late (a reboot after a missed window) pushes every later one
late with it, so the cadence drifts away from any monthly rhythm the owner's
training actually has. **The claim order:** the window is claimed before the run,
so a run that dies costs one skipped month. The alternative — claim after — was
rejected because a crash-loop would then fire a review on every boot, spending
subscription quota on repeated failures. That trade favours the wallet over the
coaching, on the assumption that a Cycle review is a survey nobody is waiting on.

**Watch for**

- **Does a skipped month get noticed?** A failed scheduled run surfaces in
  `runState` (#90), but nothing says "your monthly review didn't happen". If a
  month goes by and the gap is only discovered by wondering why the Coach record
  looks thin, "late costs nothing" was the wrong read. 🟡 → 🔴.
- **Does the drift bite?** Watch where the fires actually land over three or four
  months. If they wander into "mid-cycle" territory and the reviews start reading
  as arbitrary rather than as taking stock, the rolling interval is the cause.
- **Is a month even the right period?** Too frequent shows up as Cycle reviews
  that say the same thing a Session review already said; too rare, as a review
  that has to re-establish months of context before it can say anything.
- **Does the hourly poll ever matter?** It only decides how late a fire lands
  after a reboot. If a review ever lands at a genuinely unwelcome hour, the poll
  is the knob — but the fix is scheduling by time-of-day, not polling faster.

**If it bites**

1. **Retry a failed window instead of skipping it** — on a failed run, roll the
   claimed timestamp back so the next tick re-claims, with a bounded attempt
   count so a crash-loop still cannot spend quota indefinitely. Local to
   `cycleReviewSchedule.ts`; the claim is already the only piece of state.
2. **Anchor the schedule instead of rolling it** — fire on a fixed day-of-month
   (or on the Plan's own cycle boundary once a non-Manual Plan model exists,
   which ADR §4 defers precisely to here). Same claim mechanism, different
   due-ness predicate.

**The bigger question:** if the fires stop feeling like they land at meaningful
moments, the problem is not the interval — it is that a *time* trigger is
standing in for an *event* trigger. The ADR settles on monthly only because
today's one Plan model (Manual) has no cyclicity to hang a boundary on. If Plan
models grow boundaries and the schedule still ignores them, the schedule is the
vestige.

## 6. ⬜ Silent enrichment: metadata you never see, analytics you can't check

> **The question:** a user-authored exercise is a name and nothing else until the
> coach fills in its muscles, pattern and metrics — with no badge, no "pending"
> state, and no view of what it eventually decided. Is invisible enrichment
> comfortable, or does the coach need to show its work on the catalog?

[ADR 0016](../adr/0016-user-authored-exercises-are-name-only-rows-the-coach-enriches.md)
*The row is minted immediately* / *Enrichment is a plain write*

The permissive option was taken twice over. Asking the user for metadata was
rejected because the coach authors it better, and marking un-enriched rows was
rejected because a badge on an exercise you just typed is noise about a gap that
closes by itself. Both rest on the same untested claim: **that the gap is short
and the result is right**. Nothing verifies either. Enrichment is a plain write,
so it leaves no Decision, no citation and no audit trail — the one class of coach
output with nothing to inspect after the fact.

**Watch for**

- **Did the coach ever reason off bad metadata?** The named risk, and the only
  one that matters. A Proposal about "not enough posterior chain volume" while
  you have been doing RDLs the coach filed as quads. 🟡 → 🔴.
- How long the gap actually is in practice. The design says "until your next
  workout"; an exercise added to a session you then skip for three weeks is the
  case nobody costed.
- Per-muscle volume for the week you introduce a new exercise. A visible dip that
  recovers a session later is enrichment working; a dip that never recovers means
  it silently failed and nothing said so.
- Whether you ever *wanted* to look at an exercise's metadata and had nowhere to
  go. Wanting the view is the finding.

**If it bites**

1. **Make enriched metadata reviewable** — the catalog row's detail shows what
   the coach assigned, editable by hand. No contract change: metadata is already
   mutable and already re-derived on rename (ADR 0016), so this is a surface, not
   a mechanism. Most likely right answer if the complaint is "I couldn't check".
2. **Mark un-enriched rows** — reinstates the badge rejected up front, and the
   right fallback only if the complaint is about the *gap* rather than the
   *result*. Cheaper than (1) and answers less.

Floors either way: enrichment stays a plain write and never becomes a Proposal —
approving the coach's anatomy is not coaching (ADR 0016). If the result is wrong
often enough to want approval, the honest read is that the coach should not be
authoring this metadata at all, which is a different grilling.

---

## 7. ⬜ The repair turn: does it ever fire, and does it ever help?

> **The question:** an unreadable final message buys one extra agent turn to
> re-emit it. Commissioning saw **zero** bare-JSON drift in five live sessions,
> so this machinery is justified by reasoning, not by an observation.

[ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md) §6 ·
[#94](https://github.com/astefanovic/repcoach/issues/94) ·
`docs/ops/repcoach-server.md`

The free half — tolerant extraction — needs no watching: it costs nothing and
can only turn a dead run into a live one. The repair turn is the part with a
price. It was taken because the drift that *was* observed (issue #93) was
contract-shaped, hit three runs out of five, and threw away completed work each
time; two named cases are absorbed at the decode boundary, and the repair is the
general form for the case nobody has met. Nothing observed says it will ever
fire.

**Watch for**

- **Did it ever fire?** The server logs `unreadable, spending one repair turn`
  with the reason. Zero over months of real use is the finding — it means the
  named fixups were the whole problem, and this is dead machinery.
- **When it fired, did it work?** A repair that gets `did not fix it` every time
  is a run lost twice instead of once, at higher cost.
- **Which reason fires.** `contract` is what it was built for. A run of
  `no-json` (the model answering in prose) would mean the real problem is the
  prompt, not the wrapping.
- **Cost per run on the ledger** ([#81](https://github.com/astefanovic/repcoach/issues/81)).
  The repair's tokens are summed into the same row on purpose: a run that is
  quietly always two sessions should be visible as a cost outlier, not
  invisible. 🟡 → 🔴 if repairs become routine rather than exceptional.

**If it bites**

1. **Drop the repair turn, keep the extraction** — if it never fires, or never
   helps when it does. Pure deletion, no contract change: the typed failure it
   falls back to already exists and is already what the user sees.
2. **Fix it upstream instead** — if a specific deviation repeats, absorb it at
   the decode boundary the way `dropNullValues` and `defaultEmptyDecisionLists`
   already do, or state it in the seed. Cheaper than a session, every time, and
   the repair stays as the backstop for the *unnamed* case.

Floors either way: the repair never re-reasons and never invents content to fill
a hole (ADR 0011 §6), the three *working* fields are never defaulted, and
recovery stays bounded at one attempt — "spend more until it parses" is not a
fallback on this list.

## 8. ⬜ Replayed agents: do the cassettes stay honest, or just stay green?

> **The question:** rung 2 can now run the real adapters against **recorded**
> transcripts, deterministically and for free. Does that keep catching real
> contract breakage, or does it settle into a suite that passes over replies the
> live model would no longer give?

[#95](https://github.com/astefanovic/repcoach/issues/95) ·
[#93](https://github.com/astefanovic/repcoach/issues/93) ·
`docs/agents/testing.md` → *Agent-backed rung 2*

Record-and-replay was chosen **alongside** an opt-in live mode rather than
instead of it, and the known cost was named up front: fixtures go stale
silently. The mitigation is a prompt-scaffold fingerprint that refuses a
cassette recorded against different instructions — but it hashes the *scaffold*,
not the whole prompt, so a seed change or a reworded pointer digest slips past
it by design. Whether that line is drawn in the right place is not knowable from
here.

The cassettes committed today are **hand-seeded**, reproducing #93's observed
deviations rather than being verbatim recordings, because the alternative was to
spend a live run before the machinery existed. That is a deliberate IOU, and the
first real recording is what settles whether the format survives contact with an
actual transcript.

**First observation, on the merge that shipped this (2026-08-07).** [#104](https://github.com/astefanovic/repcoach/issues/104)
landed on master while #95 was in review and **changed the deliberator's
prompt** — it teaches the coach to emit `catalog_enrichments`. The fingerprint
stayed silent, correctly by its own rules and uselessly by the standard that
matters: #104 put its instructions in `seedContext.ts`, which is assembled into
the prompt but is not part of the hashed *scaffold*. The cassettes still decode
(the new field is optional, and rung 1 is green), so nothing broke — but the
blind spot named two paragraphs above stopped being hypothetical the first time
a prompt changed. Fallback 1 is now the live candidate, not a contingency.

**Watch for**

- **Did replay ever go red for a real reason?** A contract tightened, a field
  renamed, an absorber removed. One genuine catch justifies the whole rung; a
  year of green while prompts churned is the failure.
- **How many more prompt changes pass unnoticed.** One is a data point, and the
  cheap fix (hash the seed's static sections too) is already written down. Three
  would mean the fingerprint is measuring the wrong thing.
- **How often the fingerprint fires, and what happens next.** Re-recording is
  the intended answer; reaching for `cassettes:restamp` every time is the
  tell that the fingerprint is too sensitive to be believed, and the moment it
  stops being read as a signal.
- **Whether anyone runs the live mode at all.** Replay is free, so it will run;
  live costs quota and attention. If the live suite is never run, the cassettes
  are the only thing standing between prompt changes and the phone, and the
  staleness risk is no longer hypothetical.
- **The budget defaults (24 sessions, $5) at real use.** Both are guesses. A run
  that legitimately exceeds them reads as a refusal, which is the wrong kind of
  failure; a runaway that stays under them means the bound never bound anything.

**If it bites**

1. **Widen the fingerprint to the whole prompt minus the data window** — hash
   the seed's static sections too, and accept more re-recording. The right
   answer if staleness is getting through; costs a re-record on every prompt
   edit, which is the trade being made deliberately rather than by accident.
2. **Make live the gate and replay the smoke test** — invert which one is
   authoritative: a live agent-backed run required before a release, replay
   demoted to a fast contract check. The right answer if replay keeps passing
   over things the live run then catches. Costs quota per release, which is
   exactly what the current shape was avoiding.

Floors either way: the default suite stays canned, fast and quota-free, and the
adversarial-author constraint is untouched — an agent-backed flow asserts on
structure and outcome, never on generated prose.

**The bigger question — is the agent layer testable below UAT at all?**

If replay only ever catches breakage that rung 1's decode test already caught,
and every finding that mattered came from a live run or from the phone, then the
honest read is that the cassettes are ceremony: the thing under test is a model,
and a recording of a model is not one. That would argue for deleting the replay
mode, keeping the transport seam and the live suite, and accepting that the
agent layer's real gate is human use — which is where it was before #95, but
chosen rather than defaulted into.

---

## 9. ⬜ An open catalog: does the coach's naming stay disciplined?

> **The question:** the coach may now mint Exercise catalog rows — at Intake for
> every movement in a cold-start plan, and at any review through a Proposal's
> `catalog_exercises`. Nothing dedupes them. Does one lift stay one row, or does
> the catalog silently accumulate "Incline DB Press" beside "Incline Dumbbell
> Press", splitting the history that makes progression legible?

[ADR 0016](../adr/0016-user-authored-exercises-are-name-only-rows-the-coach-enriches.md)
*Consequences* — the resolved "may the coach propose new exercises" question

The permissive option, twice. The alternative — a closed catalog the coach may
only pick from — was what the Intake seed actually said, and it deadlocked cold
start: the catalog is empty until a plan is accepted, and no plan could be
drafted without one. Fixing that meant opening the set, and once it is open the
only thing standing between the coach and a duplicate row is **an instruction in
a prompt**: reuse an id where the movement matches, mint one where it does not.
No uniqueness check, no fuzzy name match, no merge tool. Rows are permanent and
never deleted (past Logged Sessions reference them), so a duplicate is not a
tidy-up — it is a permanent fork in one lift's history.

The bet is that a model that can see the whole catalog in its seed will reuse
from it. Plausible, untested, and the failure is quiet: two rows both look
correct in isolation.

**Watch for**

- **Two rows for one lift.** The whole entry. Most likely at the seam between
  Intake's ids and a later review's — different runs, different sessions, no
  shared context beyond the seed. 🟡 first sighting → 🔴 if it recurs.
- Per-exercise progression that resets for no reason. The symptom you would
  notice *before* you notice the cause: a lift that has been climbing for a
  month starts from nothing because the new sets went to a new row.
- Names you would not have chosen. Not a duplicate, but the tell for whether the
  coach's naming is deliberate or incidental — and the thing rename exists for.
- Rows for exercises never trained, from Proposals accepted and then edited
  away. ADR 0016 already accepts orphans as untidiness; this makes more of them.

**If it bites**

1. **Show the coach's new rows on the Proposal card, as their own line.** The
   cheapest fix and the one that matches how everything else here works: the
   user already approves the prescription, so approving "and this creates a new
   exercise called X" is one more line on a card they are reading anyway. Turns
   a silent mint into a reviewable one without adding a mechanism.
2. **Match on name before minting** — server-side, at the fold: a declared row
   whose normalised name already exists resolves to the standing id instead of
   creating a second. Cheap, but guesses on the user's behalf, and a wrong match
   is worse than a duplicate (it merges two genuinely different lifts). Right
   only if (1) shows the coach is trying to reuse and merely failing to.

Floors either way: creating an Exercise stays a plain write, never a Decision
(ADR 0016) — the row is not a coaching judgment. And ids stay permanent: the fix
for a duplicate is a rename and a merge, never a delete.

---

## 10. ⬜ Stats: does a consistency heatmap earn its own destination?

> **The question:** #117 shipped a whole new surface — a GitHub-style
> consistency heatmap, its own aggregate RPC, its own route — on the
> assumption that *seeing* consistency changes behaviour. Nothing has
> observed that yet, and #42's IA was deliberately kept to four destinations
> twice since (Revise/#60 folded a chat-style exchange into the Proposal card
> rather than open a fifth slot; the same call was available here and was not
> taken — Stats hangs off Today, same as History, rather than claiming a dock
> slot of its own).

[#117](https://github.com/astefanovic/repcoach/issues/117) ·
[#42](https://github.com/astefanovic/repcoach/issues/42) (the settled four-destination IA) ·
`docs/design/ui-surfaces.md`

The ticket's own scope line: "ship the graph and the shell around it... and
then let daily use say what actually belongs on it." Volume trends, PR
tracking, per-exercise progression are all deliberately out of scope for
exactly that reason — building them before anyone has opened the empty grid
once would be designing the second screen before knowing the first one
mattered.

**Watch for**

- **Is the Stats link ever tapped after the first week?** The whole
  question. A grid opened once out of curiosity and never again means the
  surface is answering a question nobody keeps asking.
- Does the empty state (a grid of grey squares, "No sets logged yet") ever
  read as broken rather than honest, before there's enough history to fill
  it in?
- Does the heatmap's own bucket-threshold scaling (`computeBucketThresholds`,
  `client-runtime/src/stats/heatmap.ts`) ever look wrong on a real, months-long
  distribution — e.g. a single hard week permanently recalibrating what
  counts as "a lot"?
- Whether tapping a logged day and landing on the unscoped History list
  (rather than that day's specific session — no date-to-session RPC exists,
  deliberately not built for this ticket) is ever felt as a missing feature
  or is never noticed.

**If it bites**

1. **Fold the graph into Today as a strip** — a compact, few-week version
   sitting above or below the session picker, no route of its own. Cheapest
   fallback if the answer is "worth seeing, not worth a trip".
2. **Drop it** — if the link is never tapped and the empty state never fills
   in because nobody returns to check. The RPC and runtime module are small
   and isolated enough that removing the surface costs one route and one
   link, not a migration.

## 11. ⬜ Swap only before the first logged Set — too restrictive?

> **The question:** "Swap this exercise" is offered only while an Entry has
> zero logged Sets — a real mid-workout equipment failure after set 2 has no
> swap affordance at all, only the option to keep logging the wrong exercise
> or add an unrelated unplanned Entry. Is the pre-logging-only rule the right
> cut, or does real gym use hit the gap often enough to need the split-Entry
> option?

[ADR 0019](../adr/0019-a-swap-is-an-entry-level-actual-side-annotation.md)
*What happens to already-logged Sets* / *Consequences* ·
[#131](https://github.com/astefanovic/repcoach/issues/131)

The cheap option was taken over the truthful-but-expensive one on reasoning
alone: the ticket sketched three shapes (offered only pre-logging / splits the
Entry / moves logged Sets to the new exercise), and pre-logging-only was
chosen because it needs no new Scaffold node, no per-Set exercise override,
and no new question for Session review's per-Entry volume/stall reasoning.
Nobody has actually hit "equipment gave out on set 3 of 4" while using the
app to know whether that gap is common or vanishingly rare.

**Watch for**

- **Does a mid-Entry equipment failure ever actually happen?** The named
  risk. If a session ends with a couple of Sets logged against an exercise
  the user then had to abandon, with no way to record what they finished on
  instead, that is the gap biting. 🟡 → 🔴 on repeat occurrence.
- Whether the user reaches for "another straight set" on a *different*
  Entry as a workaround, or just under-logs the abandoned exercise's
  remaining Sets and says nothing — the latter is silent data loss the coach
  can never recover.
- How often "swap" gets tapped at all, and whether it is always at set zero
  (the design's assumption) or the user is visibly hunting for it after
  Sets exist (`canSwapEntry` already hid the affordance, so this shows up as
  the "+" sheet being opened and closed without effect, not as an error).

**If it bites**

1. **Split the Entry** — the option this ADR named and declined: logged
   Sets stay against the old exercise, a new Entry (or Entry-scoped Set
   range) carries the rest against the swapped one. Amends ADR 0019's
   already-logged-Sets rule only; the Entry-scoped `swaps` model, the
   by-value ids, and "never touches the Plan" all survive unchanged.
2. **Widen the unplanned-Set escape hatch** — let "another straight set"
   accept a different exercise per added Set, so an abandoned Entry's
   remainder gets logged honestly without a formal swap at all. Cheaper than
   (1), but leaves the Entry's own display still naming the old exercise for
   its earlier Sets, which is arguably more honest, not less.

Floors either way: a swap never overwrites the frozen prescribed copy, and
whichever fallback lands still keys idempotency on `commandId` and never
mints a Plan Change.

---

## 12. ⬜ A retraction the coach never sees: is every un-log really a mis-tap?

> **The question:** un-logging a Set leaves a tombstone the deliberator is
> explicitly not shown — it reads net state, so a retracted Set is simply
> absent. Is a retraction always noise, or is it sometimes the most
> informative thing that happened in the session?

[ADR 0019](../adr/0019-an-actual-is-retracted-by-a-tombstone-never-deleted.md)
· [#83](https://github.com/astefanovic/repcoach/issues/83)

The reasoning was ADR 0002's posture against a twitchy coach: a fat-finger
corrected three seconds later says something about your hands, not your
training, and a Session review that reasons over it is reasoning over the wrong
thing. But that argument only covers the mis-tap. The *deliberate* retraction
— logged the set, then decided it did not count, and un-logged it a minute
later — is a judgement about the work, and the coach is currently blind to
it. The rows are there; nothing reads them.

**Watch for**

- **The gap between retraction and the log that preceded it.** Seconds is a
  mis-tap. Minutes, especially after the rest timer ran, is a decision. If the
  distribution is bimodal, the "always noise" premise is wrong on its face.
- Whether a Session review ever draws a conclusion that a retracted Set would
  have changed — the observable version is noticing an Observation about
  volume or consistency that reads as wrong to you *because* of a set you took
  back.
- Retractions clustered on one Entry across sessions. That is not a hand
  problem; that is an exercise you keep abandoning, which is exactly the kind
  of trend the coach exists to spot.
- The opposite signal, which would close this green: retractions are rare,
  always within seconds, and you never once think about one afterwards.

**If it bites**

1. **Expose the gap, not the row** — the deliberation snapshot gains
   retractions whose interval since the original exceeds a threshold, still as
   net-state-absent Sets but with the fact of the retraction attached. Keeps
   mis-taps invisible without inventing a new concept; no ADR 0019 change, since
   it fixes what "the coach sees" reads rather than how retraction is stored.
2. **Make it a Context note prompt** — a deliberate retraction offers the
   existing "Add a note" affordance ([#130](https://github.com/astefanovic/repcoach/issues/130))
   rather than being inferred at all, putting the judgement in the user's words
   where the coach already reads them. More honest, more friction; the right
   answer only if the inferred version turns out ambiguous in practice.

**The bigger question:** if a deliberate retraction is a real signal, then
"un-log" is carrying two unrelated acts under one gesture — *I did not press
this* and *that did not count* — and the surface, not the storage, is the
thing that under-modelled it.

---

## 13. ⬜ One active row, guarded in the client — is that enough?

> **The question:** #147 makes the server the source of truth for a workout in
> flight, but the "one intended workout, one `active` row" guard lives in the
> *client's* `startWorkout` command, not in `startSession`. Is a client-side
> adopt-don't-mint guard enough, or does the store need to refuse the duplicate?

[ADR 0020](../adr/0020-a-workout-in-flight-is-a-server-fact-the-pointer-is-a-hint.md)
· [#147](https://github.com/astefanovic/repcoach/issues/147)

Store-level idempotency was rejected on cost: `startSession` is non-idempotent by
design (a re-start is a fresh copy of the current Plan) and ~50 rung-1 tests
depend on that. The client guard closes the realistic path — same device, lost
pointer, tap Start — and the reconcile on Today means the user usually taps
Resume anyway. What it does **not** close: two devices, or two tabs, tapping
Start within the same round-trip.

**Watch for**

- **A second `active` row you did not intend.** The observable version:
  `scripts/Get-UnreviewedSessions.mjs` or a glance at the DB showing two `active`
  Logged Sessions for the same Prescribed Session, or Today briefly offering
  Resume for a session with nothing logged in it.
- Whether you ever actually drive the app from two devices mid-workout. If the
  phone is the only client that ever logs sets, the race is unreachable and this
  closes 🟢 on "never happened, could not happen".
- A reconcile that adopts the *wrong* session — you meant to start fresh, and
  Today resumed a stale one instead because it was still `active`. That is the
  guard being too eager, the opposite failure.
- Offline Start immediately after a site-data wipe: the guard can't reach
  `listActiveSessions`, mints a row, and the earlier session is briefly a
  duplicate until the next connect's reconcile. Does that window ever show?

**If it bites**

1. **Refuse in the store** — `startSession` fails (or returns the existing id)
   when an `active` row exists for that Prescribed Session. The rung-1 fallout is
   mechanical: the tests that spam `startSession` finalize or cancel between
   calls. Amends ADR 0020's "left non-idempotent" decision.
2. **A short server-side claim** — `startSession` writes a brief
   `(prescribed_session_id → loggedSessionId)` lease so a second Start within N
   seconds returns the first row without changing `startSession`'s contract for
   the common case. More machinery; only worth it if the race is real but the
   full refusal breaks something legitimate.

**The bigger question — should "resume vs. start fresh" be the user's explicit
choice?** Today the app decides: an `active` session for this Prescribed Session
means Resume, full stop. If daily-driving turns up cases where you genuinely want
to abandon an open session and start clean, the honest fix is not a better
heuristic but a visible "you have an unfinished {session} — resume it, or discard
and start over?" — which also makes the orphaned-session state impossible to
reach by accident.

## 14. ⬜ Tier-2 seed is online-only: does a cold offline start feel broken?

> **The question:** one tap on ✓ seeds an unprescribed metric from tier 1
> (this session's earlier Sets — offline) then tier 2 (the last time this
> Exercise was performed — a server read, **not cached**). A workout started
> in a dead spot gets tier 1 only; before the first Set of an Entry is
> logged, an unprescribed load shows `–`, not the number you have lifted for
> months. Is that a real annoyance, or does tier 1 cover it in practice?

[ADR 0021](../adr/0021-one-tap-confirm-seeds-an-unprescribed-metric.md)
· [#149](https://github.com/astefanovic/repcoach/issues/149)

Tier 2 was left uncached to keep the change small: `useLastExerciseActuals`
fires the RPC fire-and-forget and returns nothing on failure, so offline is an
honest absence rather than a hang. The bet is that the first Set of an
unprescribed-load Entry is nearly always logged **online** (you start the app
at the gym, on wifi or signal), after which tier 1 carries every later Set of
that Entry for free — so the offline gap is only ever "the very first Set of an
Entry, in a dead spot", which is rare.

**Watch for**

- Starting a workout offline and finding the first Set of a machine / DB
  exercise opens the stepper at 0 (or shows `–`) when you know last week's
  number. Once is nothing; every offline session is the signal.
- Noticing you now wait for the row to populate before tapping ✓ — the seed
  arriving a beat late because the RPC is in flight, turning a one-tap flow
  into a one-tap-after-a-pause flow even when online.
- The opposite, which closes this green: you never once start a workout
  without connectivity, or when you do, tier 1 has always kicked in by the
  Set you care about.

**If it bites**

1. **Prefetch into a durable cache on "Start workout"** — the prescription
   cache (`packages/client-runtime/src/prescription/cache.ts`) is the exact
   precedent: on a connected Start, fetch `lastActualForExercise` for every
   Exercise in the Session and cache it beside the prescription, frozen for
   the workout. Adds a storage + model + cache module mirroring the
   prescription one; no contract change.
2. **Fold last-use into the prescription prefetch response itself** — the
   server attaches each Entry's last-performed actuals to
   `getPrescribedSession` / the Logged Session read, so there is one fetch and
   one cache, not two. Cleaner, but widens a contract that today is purely the
   frozen prescription.

**The bigger question:** if tier 2 is worth caching, then "what did I do last
time" is workout-start context on the same footing as the prescription
itself — and the split between "the plan" (cached, frozen) and "my history"
(fetched live, per surface) is an accident of how the surfaces grew, not a
real seam.

## 15. ⬜ The Coach activity pip: does it get you to open Coach, or just train you to ignore a dot?

> **The question:** the Coach glyph now carries a **pip** — a dot meaning "a
> Deliberation run has settled that you haven't seen" — on top of its existing
> count of decisions owed. #42 user story 36 deliberately kept that glyph a
> to-do count and *not* a notification; ADR 0022 re-introduces the notification
> as a separate mark, betting that a coach whose finished work is invisible is
> a coach you stop trusting. Is that bet right?

[ADR 0022](../adr/0022-the-coach-glyph-carries-two-signals-a-count-you-owe-and-a-pip-you-havent-seen.md)
· [#150](https://github.com/astefanovic/repcoach/issues/150)

Two sub-bets, judged together:

- **The pip is worth having.** A finished Session review that said nothing, and
  a run that failed, had no representation on the dock at all. The pip makes
  them visible without adding a surface.
- **The marker is device-local.** `localStorage`, like the in-flight pointer —
  cheap, synchronous, and wrong the moment there are two devices, where each
  keeps its own "last seen" and its own pip. #147 is the cautionary tale for
  device-local state; this is a deliberately smaller bet, because a
  mis-lit pip costs a wasted glance, not a stranded workout.

**Watch for**

- **Did the pip ever actually send you to `/coach`?** The whole point. If every
  time you noticed it you already knew what the run was (because the strip
  flashed, or you were watching), it is decoration.
- **Did you start ignoring it?** The failure mode story 36 was written against.
  A dot that is lit more often than not stops being a signal. If it feels
  permanently on, the "quiet run also lights it" rule is too generous.
- **The two-device irritation.** Reviewing on the laptop, then the phone still
  showing a pip for the run you just read. How often, and does it annoy you or
  do you not notice.
- **A failed run you'd have missed.** The strongest evidence *for*: a run died,
  you were not looking, and the pip is the only reason you found out before the
  next workout.
- The opposite signal that closes this green: you glance at the pip, it takes
  you to `/coach` to read something you're glad you read, and you never once
  think about the laptop-vs-phone mismatch.

**If it bites**

1. **Narrow what lights it** — a run that *emitted at least one Decision*
   lights the pip; a quiet run does not. Keeps the failed-run and
   said-something cases, drops the one most likely to make the dot feel
   permanent. No ADR 0022 change to the pip/count split, only to §1's
   predicate (`coachActivity.ts`).
2. **Move the marker server-side** — a `coachSeenAt` column, read alongside the
   run list that is already server state. Closes the two-device gap outright.
   Pre-planned in ADR 0022 §3 as the fallback; it is a schema migration, which
   is why it was not done first.

**The bigger question:** if the pip turns out to be the thing you actually
look at and the count is not, then the glyph's primary job was never
"decisions owed" — it was "did the coach do anything" — and story 36 optimised
the wrong signal.

## 16. ⬜ Next up by rotation: is a weekday-blind hint enough?

> **The question:** Today suggests the session after the last one you finished
> and wraps at the end of the list. Weekday tags were deliberately not built.
> Does the rotation hint pick the right session often enough that you just tap
> it, or does real life keep pulling you back to the list?

[ADR 0023](../adr/0023-next-up-is-a-derived-rotation-hint-not-a-schedule.md)
§1/§2 · competitor comparison gap #1

The simpler concept won on reasoning alone: a rotation survives a missed day,
needs no schema change, and does not assert weekly cyclicity. Weekdays were
rejected without anyone having trained with either. Both open-source users
(who often follow fixed-day programs) and a changing personal schedule could
vindicate them.

**Watch for**

- **How often you tap the hero versus a list row.** The whole point. A hero
  you skip past most sessions is noise in the most valuable slot on Today.
- **Overrides with a reason that is about the calendar** ("it's Friday, I do
  legs on Friday", "gym's busy on Mondays, so not bench"). Those are weekday
  tags asking to exist.
- **Overrides that then make the next hint wrong.** Picking out of order once
  shifts the rotation from there; if that feels like the app "forgot" where you
  were, the anchor (last finished) is the wrong one.
- **A lap that wraps when you didn't want it to**, for example a plan you
  meant to run once through.
- The signal that closes this green: you open the app, tap the hero, and never
  think about which day it is.

**If it bites**

1. **Anchor on the furthest-along session instead of the last finished** —
   an out-of-order pick no longer resets the rotation. Local to the derivation
   (ADR 0023 §2); no schema change.
2. **Optional weekday tags as a tiebreak** — a per-Prescribed-Session weekday
   set, a new Plan field and Plan operation; the hero prefers a session tagged
   for today, otherwise falls back to rotation. This is the deferred half of
   ADR 0007's binding selection and needs its own grilling first.

**The bigger question:** if you keep wanting the app to know *when* you train,
not just *what's next*, the Manual model is being asked to schedule, and the
real answer is the first cyclic Plan model, not a field bolted onto this one.

<!-- Next entry goes here. -->
