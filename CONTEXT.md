# RepCoach

A personal, phone-first weight-training app: a structured workout log as the data layer, with a proactive Claude-powered coaching layer that reasons over that data (plus recovery and lifestyle signals) and pushes the user toward evidence-grounded improvements they wouldn't know to ask for.

## Language

**Plan**:
The user's standing, agreed training structure — the prescribed exercises, set/rep schemes, and progression rules they walk into the gym with. Claude edits the Plan over time; it is the single source of truth for "what should I do today." A Plan is not assumed to be cyclic; its structure is determined by its Plan model. Concretely the Plan holds an **ordered list of Prescribed Sessions** plus its Plan model; the order is authored data and carries no calendar or cyclicity claim.
_Avoid_: Program, routine, schedule

**Plan model**:
The strategy that determines how a Plan is structured and how the next Session is chosen — e.g. linear progression, weekly undulating, block/mesocycle periodization, or non-cyclic autoregulation. Claude selects and may switch the Plan model based on evidence and the user's data and goals; it is data the app stores, never logic hardcoded into the app. Switching models is a Change (raised as a Proposal). The degenerate case is the **Manual Plan model**.
_Avoid_: Periodization (that is one model), template

**Manual Plan model**:
The degenerate Plan model where the user hand-authors Prescribed Sessions directly, picks today's Session manually, and no Progression rule fires — no progression logic, no periodization, no cyclicity. It is the *no-model* model: a real Plan that simply leaves every model decision to the user. A richer model (linear, undulating, block…) later replaces it via a model-switch Change, slotting on top of the same Scaffold without rework.
_Avoid_: No model, null model, manual mode

**Next up**:
The Prescribed Session Today suggests: the one after the session your most recently finished workout came from, in the Plan's authored order, wrapping from the last back to the first. It is a **hint, not a schedule** — derived live from the Plan and the finished Logged Sessions, stored nowhere, never auto-started, and unknown to the coach; the user still picks, and tapping the hero is just the cheapest pick. It is the one place the app treats the order as a loop; the Plan itself stays non-cyclic ([ADR 0023](docs/adr/0023-next-up-is-a-derived-rotation-hint-not-a-schedule.md)).
_Avoid_: Today's session, scheduled session

**Session**:
The Scaffold unit of one workout — a tree of `Block → Entry → Set`. A Session exists in two states: a **Prescribed Session** (targets only, lives in the Plan) and a **Logged Session** (an instantiated copy that carries actuals). The same node types are used in both states, so prescribed-vs-actual is a row-for-row alignment rather than a join.
_Avoid_: Workout (the act), day, session template

**Prescribed Session**:
A Session in prescription-only form — every node carries a prescribed side and no actual. It is the reusable blueprint the Plan stores (informally a "day template"); the Plan holds an ordered list of them. Starting a workout **instantiates** it: a deep copy becomes a Logged Session. Because it is copied, later edits to the Prescribed Session never reach past or in-flight Logged Sessions.
_Avoid_: Day template, template, routine day

**Logged Session**:
The instantiated copy of a Prescribed Session that a workout is recorded into — every node carries the copied prescribed side **and** an actual side that logging fills. Skips (prescribed, no actual), unplanned work (actual, no prescribed), and swaps (actual identity ≠ prescribed identity, e.g. an Entry whose exercise was substituted) all live here; the retained prescribed side makes swap- and skip-provenance free. Per ADR 0006 logging never mutates the Plan. A Logged Session's lifecycle status is `active` (in flight), `finished`, or `cancelled`; while it is `active` the app offers **Resume** in place of the session picker. That offer's source of truth is the server (`logging.listActiveSessions`), reconciled on connect against a device-local pointer that is only a first-render hint — so a browser that lost its site data still finds its open workout ([ADR 0020](docs/adr/0020-a-workout-in-flight-is-a-server-fact-the-pointer-is-a-hint.md)).
_Avoid_: Workout log, actual session

**Entry**:
A node inside a Block holding one Exercise (from the Exercise catalog) and its ordered list of Sets. In a Logged Session an Entry carries both a prescribed exercise identity and an actual one; when they differ, that is a swap.
_Avoid_: Exercise row, movement, lift

**Swap**:
Recording that an Entry's Sets were actually performed against a different Exercise than the one prescribed — "did DB press instead of the prescribed barbell press", not an edit to what was prescribed. A **pure actual-side annotation** ([ADR 0019](docs/adr/0019-a-swap-is-an-entry-level-actual-side-annotation.md)): the frozen prescribed exercise is never overwritten, so both the prescribed and performed identity stay legible on the same Entry indefinitely. Offered only while the Entry has zero logged Sets — the cheapest defensible rule for what happens to Sets already logged against the old exercise, chosen over splitting the Entry or moving the logged Sets (see ADR 0019, and `docs/design/uat-watchlist.md` #11 for whether that cut is too restrictive). The swapped-to Exercise is picked from the same catalog picker the Plan uses and may be a User-authored exercise. Like every other logging capture, a swap never mints a Change and never touches the Plan. Finishing a workout that swapped a prescribed Entry then **asks** whether to swap it in the Plan too; saying yes is a separate user-direct `setEntryExercise` Change, not part of the swap ([ADR 0019](docs/adr/0019-a-swap-is-an-entry-level-actual-side-annotation.md), 2026-10-13 amendment).
_Avoid_: Substitution, replace exercise, exercise edit

**Scaffold**:
The generic, plan-model-agnostic schema that can represent any weight-training Plan. The bet behind RepCoach: a structure simple enough to hold any plan ("most gym workouts fit in a spreadsheet") yet rich enough for Claude to reason over and reshape. Concepts like mesocycle or deload are vocabulary of a particular Plan model, never primitives of the Scaffold.
_Avoid_: Schema, framework

**Progression rule**:
Pre-negotiated logic baked into the Plan that resolves concrete targets from actual performance (e.g. "add 2.5 kg when you hit the top of the rep range"). When a rule fires it is the Plan *executing as designed*, not a Change — the user already approved it by approving the Plan.
_Avoid_: Auto-progression, scheme

**Change**:
A forward-looking modification to the Plan — tiny (drop a set for fatigue) or large (swap the session to technique work), or any structural edit to the Plan itself. Every Change carries an **origin** (`coach-proposal` vs `user-direct`) and a **status** (`pending` / `accepted` / `rejected` / `applied` / `superseded`); these two axes are what let the coach later reason over the Plan's history. A Change has exactly two origins, which behave differently: a **coach-proposal** is a Deliberation Proposal raised for the user's approval (it only mutates the Plan on `accepted`; a `rejected` one is *retained* as coach context — a record of what was offered and declined, like an ADR for the Plan); a **user-direct** edit (the user editing the Plan outside a workout) is **auto-applied** without approval (born `applied`) — you do not approve your own edit — and is recorded so the coach can read it as a revealed-preference signal, not block it. Logging is **never** a source of a Change: doing 7 reps instead of 8, dropping a set, or swapping an exercise mid-session is captured as **actual** only — a prescribed-vs-actual delta that is pure data, not a plan modification. Such a deviation is raw material for Session review (which may raise an Observation, later a Proposal), never an auto-minted Change. Distinct from a Progression rule firing, which is not a Change.
_Avoid_: Edit, adjustment, tweak

**Proposal**:
A Decision in the pending state — a Change the agent has already deliberated and recorded, surfaced to the user for approval with its cited rationale. The user accepts, dismisses, or **Revises** it; the Plan only mutates on acceptance. A Revise may supersede it with a revised Proposal, so a Proposal on Today is the head of a **Proposal lineage**, not necessarily the coach's first draft ([ADR 0013](docs/adr/0013-revise-user-invoked-amendment-of-a-drafted-decision.md)).
_Avoid_: Suggestion, recommendation

**Decision**:
A single recorded coaching determination: what changed (or is proposed, or is answered), the rationale, the citations, and the data window it was based on. Decisions are produced by Deliberation ahead of time, never invented on the fly. Three kinds: a pending Decision is a **Proposal**, a watching-this finding is an **Observation**, and a reply that proposes no Change is an **Answer**. Immutable once recorded — amendments are new Decisions (ADR 0002); only `status` ever moves.
_Avoid_: Recommendation, call

**Decision log**:
The append-only, auditable, queryable record of every Decision. Powers two requirements: explainability (a layered account — quick cited summary on top, deeper evidence and the rule that fired underneath) and stall detection over the *prescription* (you can only say "this has been stuck" if you recorded what you kept prescribing). It does not store analytics — those are derived.
_Avoid_: History, audit trail

**Deliberation**:
The ahead-of-time process that produces a Decision: analyze the Log and derived analytics, gather evidence and research, form an opinion, and record a cited Decision — modeled on the grill→ADR flow, with the agent bringing its own research and stance to reach a shared decision with the user. The chat is where the user interrogates or amends a Deliberation, never where coaching decisions originate. Its concrete execution shape is the **Deliberation run** ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md)).
_Avoid_: Reasoning, analysis, chat

**Deliberation run**:
The concrete execution of a Deliberation on the home-server Agent SDK ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md)). One **deliberator** session (native Claude Code tools — `sqlite3` over a *read-only* DB snapshot, web retrieval — over a deliberately **thin seed context** it augments by pulling data on demand) drafts Decision(s), then a one-way **Adversarial sweep** verifies and rewrites the draft into the committed output. The runner — never the agent — performs the only write-back into the store. Comes in **three prompt framings on one review runner** — **Session review**, **Cycle review**, **Revision run** — plus the distinct interactive **Intake** cold-start. Non-deterministic by nature: "auditable" means its **Data window** and citations are reconstructable, not that the run reproduces. A run is **recorded in its own right**, not merely through what it emitted: it has a row carrying its cadence, its outcome (`running` / `committed` / `failed`), the reason it failed, and the window it read — written by the runner alone and never allowed to fail the run it records ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md) §8). Without that row two states are unsayable: a run that looked and **said nothing** writes no Decision at all, so the coach's restraint would be indistinguishable from its absence, and a run that **failed** would forget why on the next restart. The **Decision log** is therefore read as a history of runs, each with the Decisions it produced beneath it.
_Avoid_: Job, task, pipeline

**Adversarial sweep**:
The short second agent that runs after the deliberator and **has final, one-way authority** over a Deliberation run's output ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md)). It **fetches and reads every cited source** (claim-support, not just "the URL resolves") and **rewrites the drafted Decision in place** — stripping unverifiable citations, downgrading trust levels, and rewriting a Proposal down to an Observation or a "reasoning only, uncited" point where the evidence collapses. Its output *is* the committed Decision; it never negotiates back with the deliberator. The structural trust floor behind the real-citation requirement (ADR 0002/0003) — mirrors the repo's adversarial-author testing rung.
_Avoid_: Review pass, validator, critic

**Data window**:
The provenance envelope frozen onto a Decision recording *what slice of reality* it was formed against — `{ cadence, ran_at, window_from, window_to, session_ids_considered, evidence_roster_version }` (stored as `data_window_json`). With the Citation value-snapshots it is what makes a Decision **auditable**: an account of the inputs and evidence behind it, enough to check the reasoning by hand. It is not a means of reproduction — the model is non-deterministic and no run transcript is kept.
_Avoid_: Context, scope, snapshot

**Observation**:
A recorded finding from a review that does not yet warrant a Change — one dip, one sandbagged day, a single missed target. It accumulates as evidence and may later combine into a Proposal once a trend is confirmed. The anti-twitchy mechanism: the coach notices without acting, mirroring how an elite PT watches every session but withholds plan changes until a pattern is real. **Accumulation lives in the Decision log itself** — an Observation is a `decision` row born `status='open'`; each Deliberation run queries the open ones, judges whether a trend now clears a **soft, prompt-guided bar** (no hardcoded counter), and emits status directives the runner applies to Observation rows only: `escalated` when rolled into a Proposal (`escalate`), `expired` when stale or contradicted (`close`); a directive naming a non-Observation is a no-op ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md)). Only `status` moves; rationale/citations stay immutable. With no structural emission lanes, this mechanism plus the Adversarial sweep *are* the anti-twitchy guarantee.
_Avoid_: Note, flag

**Session review**:
The restrained Deliberation run the user's **Finish Workout** tap makes the app **owe** — owed, not triggered, and the distinction is load-bearing ([ADR 0018](docs/adr/0018-a-session-review-is-owed-by-a-row-not-by-a-request.md)): finishing marks the Logged Session `pending` review in the same write that finishes it and returns, a background drain performs the run, and only a *committed* run marks it `reviewed`. Since `pending` is the sole trigger, a review lost to a failed run, a low-quota deferral or a server restart is retried rather than stranded — while the debt was held by the in-flight request instead of a row, the coach silently never ran at all (#132). Looks at the fresh data but mostly emits Observations; escalates to a Proposal only when evidence clears the bar (a confirmed trend, or an acute/safety finding). There is no separate event-trigger system — events are just findings this review surfaces. Mechanically it is the same runner as a Cycle review with **no structural difference in what it may emit** — the only difference is a prompt framing to focus on the current cycle / recent data, and (typically) a cheaper configured model; its restraint is carried by the Observation mechanism and the Adversarial sweep, not by a structural lane ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md)).
_Avoid_: Post-workout check

**Cycle review**:
The heavier Deliberation run where most periodization Proposals originate (deloads, volume restructures, Plan-model changes). Same runner as a Session review, differing only in a prompt framing to weigh the **longer history** (and typically a stronger configured model). Runs **monthly** for now (a plain schedule); Plan-model-defined boundaries are a later refinement for when a non-Manual Plan model exists — the Manual model has no cyclicity, hence no boundaries ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md)). An on-demand "run now" is always available.
_Avoid_: Weekly review, checkpoint

**Revise**:
The free-text channel on a Proposal — a peer of Accept and Dismiss — through which the user interrogates ("why 5 days?"), objects ("not 5 days, I can't train more than 3"), or requests alternatives, **re-invoking Deliberation on that Decision** ([ADR 0013](docs/adr/0013-revise-user-invoked-amendment-of-a-drafted-decision.md)). It is the one place the app is conversational, and it is still not chat: it amends a Decision the coach has already drafted (ADR 0002). It expands in place on the card and never navigates — there is no chat destination. Named for what the *coach* does in response: the user does not edit the Proposal (that would be a `user-direct` Change), they ask the coach to reconsider and it decides.
_Avoid_: Push back, modify, ask the coach, discuss, chat

**Revision run**:
The Deliberation run a **Revise** triggers — the Session-review runner under a third prompt framing (same seed, same read-only snapshot, same tools, same Adversarial sweep, same configured model), with the target Decision in full and the prior exchange added to the seed. It emits **exactly one Answer plus at most one revised Proposal**; the runner discards anything off-subject (other Proposals, directives on unrelated Observations) and keeps new Observations unsurfaced. Uncapped and sequential — the user may Revise again, but only one run is in flight, and the Proposal card **locks** until it lands or is **cancelled**.
_Avoid_: Push-back run, amendment run, follow-up, chat turn

**Answer**:
A Decision that replies without proposing a Change — the coach's cited response to a **Revise**. Immutable, carries its own Citations and Data window, and degrades to "reasoning only, uncited" under the Adversarial sweep exactly as a Proposal does. Every Revision run emits one, whether or not it also revises. The third `decision.kind`, alongside Proposal and Observation.
_Avoid_: Response, reply, message, chat turn

**Proposal lineage**:
The `superseded` chain from a coach's first Proposal through each revision to the current pending head, with the **Revise** exchange (the user's prose and the coach's Answers) attached. Today shows the head with its lineage collapsed beneath it — a revised Proposal is only comprehensible alongside the objection that produced it. The Decision log shows the same rows flat and immutable. Each Decision links to the row it superseded.
_Avoid_: Thread, conversation, history, version chain

**Evidence base**:
A small server-side corpus of vetted training principles that a Deliberation cites into. It is a **floor**, not the primary tier: a **seed** of only the foundational, settled principles (progressive overload; the broad hypertrophy rep range; proximity to failure; weekly volume and its distribution; that growth is local to the loaded muscle; that soreness is not the stimulus) — those both load-bearing on the coach's first decisions and settled enough to need no retrieval. Its size is an output of that test, not a target: currently **seven** entries ([the seed](docs/evidence/evidence-base-seed.md)). Everything more specific the agent sources via live web retrieval. Each entry is `claim` + `source` + `applicability` + `trust`; the corpus grows organically as retrieved sources are promoted in (see Citation, and ADR 0003). The seed itself is **vetted and live** — the human promotion gate governs *runtime* growth, not entries authored offline against the inclusion test.
_Avoid_: Knowledge base, references

**Citation**:
A source attached to a Decision, carrying a visible trust level — `corpus-verified` (from the Evidence base) or `retrieved-unverified` (live retrieval, not yet promoted). Since the seed corpus is tiny, most early Citations are `retrieved-unverified` — expected and honestly labelled. A Citation is a **value-snapshot** frozen onto its Decision at decision time (claim + source URL + trust as-of-then), so the Decision log stays historically honest even after a source is later promoted. Retrieval is restricted to checkable scientific sources with a real URL; when none is found the coach flags the point "reasoning only, uncited" rather than fabricating a reference. A `retrieved-unverified` source cited in an accepted Proposal becomes a **promotion candidate** the owner can approve into the corpus (batch queue; never automatic). The app discloses upfront that the user should check sources: architecture reduces hallucination but does not eliminate it, so verification stays with the human and trust level is never hidden.
_Avoid_: Reference, source

**Provisional citation**:
A Citation the coach has made mid-**Intake**, before the single Adversarial sweep has ruled on it — so it carries **no trust level at all**, rather than a weak one ([ADR 0014](docs/adr/0014-intake-one-held-open-run-swept-once.md) §3). Interim turns are unswept by design (turns are cheap), so the reasoning behind a draft is shown with its sources **marked as unchecked** rather than stripped: hiding them would hide the coach's reasoning at the exact moment the user is deciding whether to argue with it. The marking is a **visible promise** that every source gets verified at convergence, and it is discharged in public on the swept card. Absence of trust is the contract, not an omission — a provisional citation cannot be mistaken for a verified one.
_Avoid_: Unverified citation, draft citation, pending citation

**Sweep disclosure**:
What the single Adversarial sweep changed, stated on the card the user is deciding on ([ADR 0014](docs/adr/0014-intake-one-held-open-run-swept-once.md) §5): one verdict per citation the plan carried — verified, retrieved-unverified, or **removed with the reason why**. "Two sources didn't hold up and were removed" is the feature working in public, not an embarrassment. It covers held sources too, so "all sources held" is a fact the card can state rather than an empty list it has to imply. Scoped to the citations *that* plan accumulated — a user who converged off the first draft is never told a source they never saw was removed. Currently required only at cold start; worth generalizing to every Proposal later.
_Avoid_: Sweep report, verification result, diff

**Check-in**:
The fast structured self-report the user enters daily or pre-session — sleep quality, soreness, stress, energy — that feeds recovery context into Deliberation. Subjective and noisy by nature, but enough to drive "bad sleep this week → lighter day." Objective device data (Health Connect / wearables) is out of reach on the web-only client ([ADR 0012](docs/adr/0012-web-only-client-supersedes-native-android.md)) — not merely deferred; it would need a separate ingestion path.
_Avoid_: Survey, readiness score

**Context note**:
Free-text life context the user tells the coach ("traveling next week, dumbbells only", "tweaked my lower back") that no structured field captures. Read by Deliberation alongside the Log and Check-ins. Usually unanchored (about the user's life, not a specific piece of training data) — but the Logging surface's note sheet item (issue #130) mints the same mechanism scoped to one Entry ("left elbow twinged on set 3", said of overhead press specifically), so the coach can tell a note about today apart from a note about one exercise. An anchored note is **edited in place** once it exists rather than joined by a second one (UAT) — the running observation about an exercise gets refined during the workout, and a stack of near-duplicate lines is noise on the screen and in the coach's context alike. Both forms land in the same Deliberation channel; the anchor is optional metadata on the note, not a separate concept.
_Avoid_: Comment, journal

**Intake**:
The cold-start sequence that produces the first Plan when no Log exists yet. Hybrid: a short structured form captures deterministic facts (days/week, equipment, lifts and current working weights), then a Deliberation run handles the judgment calls (goal nuance, injury accommodations, choosing the initial Plan model, and sharpening the Goal) and emits the first Plan as its first Decision. It is the **one interactive Deliberation run** ([ADR 0011](docs/adr/0011-deliberation-internals-run-mechanics.md)): the agent drafts a first Plan, presents it ("what do you think of this plan?"), and the user tweaks it on the fly while the agent revises — converging on the first Plan as an accept-able Proposal. This stays within the ahead-of-time principle (ADR 0002): the chat *amends a drafted Decision*, it does not originate coaching from a blank slate. Mechanically it is **one run with many turns** — a held-open deliberator session resumed turn to turn, writing nothing until convergence — where a **Revision run** is N runs of one turn each; the difference is that at cold start there is no Log to re-examine ([ADR 0014](docs/adr/0014-intake-one-held-open-run-swept-once.md)). Converging is a distinct act (**Review the sources**) that fires the single Adversarial sweep; **Accept** comes after it, on the swept output.
_Avoid_: Onboarding, signup

**Goal**:
What the coach optimizes toward. Set by the user but sharpened by the coach during Intake (grilling a vague aim into concrete, measured targets — e.g. a weight, strength, or endurance target). The **proxies and measures** used to track progress toward the Goal (e.g. e1RM trend, per-muscle weekly volume vs. evidence-based landmarks, bodyweight) are chosen by Deliberation from research and best practices — never hardcoded into the app — and the coach is candid that it reasons from proxies, not direct measurement. The coach requests optional measurements (e.g. body measurements, photos) only when it judges them useful.
_Avoid_: Objective, target (a target is one component of a Goal)

**Calibration phase**:
The opening period (roughly the first mesocycle) during which there is no trend data yet, so progression is necessarily more template-like while the coach gathers a real performance baseline. The coach states this openly rather than feigning confidence — an instance of the honest-disclosure principle. It is stated **with the first drafted Plan** (not before the Intake form, and never behind a dismissable "OK"), naming what unlocks real coaching so the caveat reads as a promise, and it is carried into the first Decision ([ADR 0014](docs/adr/0014-intake-one-held-open-run-swept-once.md) §7). Nothing persistent lands on Today.
_Avoid_: Warm-up period, trial

**Standing constraint**:
A durable, user-relevant input that every Deliberation must load and honor (distinct from a transient Context note and from the coach-authored Decision log). Carries a **hard/soft** flag: hard constraints are inviolable (injuries, firm scheduling limits) and never overridden; soft constraints are preferences the coach may *challenge with evidence* (a Proposal to revisit) but never silently break. Authorable directly by the user, or proposed by the coach when it notices a repeated pattern (promotion is itself a Proposal). The coach can cite a constraint back as the reason for a decision.
_Avoid_: Preference, rule, setting

**Coaching feed**:
The proactive stream where Claude surfaces Proposals and explanatory insights without being asked, including cross-cutting observations (recovery, cross-muscle balance, lifestyle) — not just per-exercise stalls.
_Avoid_: Notifications, tips

**Activity pip**:
The dot on the Coach destination glyph meaning *"a Deliberation run has settled that you have not opened the record to see"* ([ADR 0022](docs/adr/0022-the-coach-glyph-carries-two-signals-a-count-you-owe-and-a-pip-you-havent-seen.md)). Distinct from — and shown alongside, in a different corner of the glyph — the **numeric badge**, which counts only pending Proposals (decisions you owe an answer to; #42 user story 36, *never* a notification). The pip lights for any `committed` or `failed` run newer than this device's last visit to `/coach`, **not** for a run still in flight (that is the status strip's job) and **not** for new Proposals (that is the count's job). Cleared by opening `/coach`; the "last seen" mark is device-local (`localStorage`), so a second device keeps its own — the accepted cost, judged in uat-watchlist #16.
_Avoid_: Notification badge, unread count, alert

**Block**:
A grouping level inside a Session that holds one or more Exercise entries with a format (straight / superset / circuit / EMOM / AMRAP) and its own params (time cap, interval, target rounds). A data primitive, not a UI primitive: a plain single-exercise (straight) Block is implicit and never shown to the user as a wrapper — Blocks surface in the UI only when they group multiple exercises or use a timed format.
_Avoid_: Group, circuit (circuit is one Block format)

**Set**:
The atomic unit inside an Entry, carrying **two** metric maps over {reps, load, duration, distance, rpe/rir, tempo} — a **prescribed** target map and a **logged actual** map — plus a shared set-type tag (working / warmup / drop / myo-cluster / rest-pause). In a Prescribed Session only the target map is filled; logging fills the actual. A **prescribed target value is an interval `{min?, max?}`** (both bounds equal = an exact target like "8"; differing = a range like "8–10"; one-sided = "8+" or a "≤ RPE 8" cap; an *open* `rpe: {}` entry means "report effort, no target"), while an actual value is always a scalar. Reps are one optional metric, not the spine, so time- and distance-based work fit the same shape. Special set-types are expressed structurally — a drop / rest-pause / myo-cluster Set is read as a continuation of the nearest preceding working Set (adjacency + tag + near-zero rest), needing no parent node. **Rest is not a Set metric**: it is a prescription-only attribute, set **per Set** when authoring the Plan, and may be absent entirely (absent = no rest timer). Logging reads prescribed rest to drive the rest timer; it never records rest as logged actual.
_Avoid_: Rep, row

**Set run**:
A run of consecutive Sets within one Entry that share a set type, a target map and a rest value — `4 × 5–8 reps @ 80 kg` said as one statement. It is the **authoring unit** of the Plan editor ([#45](https://github.com/astefanovic/repcoach/issues/45)): the "N identical sets" sugar of [ADR 0007](docs/adr/0007-minimal-plan-is-degenerate-manual-plan.md) promoted from a convenience to the thing a person edits. A run is **derived, never stored** — the Plan holds Sets, so prescribed-vs-actual stays a row-for-row alignment — and it is computed by coalescing and written back by expanding. A run of count 1 is just a Set.
_Avoid_: Set group (that already means a working Set plus its drop / rest-pause / myo-cluster continuations), block, bracket

**Unplanned Set**:
A Set logged in a Logged Session that has an actual side and no node in the frozen prescribed copy (the formal case ADR 0007 names: "unplanned work is a node with an actual side and no prescribed"). It is client-minted (a fresh `SetId`, never round-tripping through the Prescribed Session) and captured through the same `logSetActual` path every prescribed Set uses ([ADR 0017](docs/adr/0017-unplanned-set-is-a-client-echoed-actual-only-node.md)) — no separate contract or storage exists for it. "Another straight set" echoes the Entry's last working Set's target verbatim so it renders and confirms like any other row; it never extends the Plan.
_Avoid_: Extra set (ambiguous with a prescribed Set simply not yet confirmed), ad-hoc set

**Retraction**:
An appended `logged_set_actual` row stating that a Set was **not performed after all** — how un-logging works, since nothing is ever deleted from the actuals table ([ADR 0019](docs/adr/0019-an-actual-is-retracted-by-a-tombstone-never-deleted.md)). It carries no metric map, travels the outbox as its own command kind (`unlogSetActual`), and is idempotent under replay by the same `UNIQUE(command_id)` every capture uses. A Set's **net state** is its last row by application order, so a retraction in that position reads as unlogged; a later actual for the same Set logs it again. Distinct from a **correction**, which is a fresh actual for the same Set — "I did fewer reps" rather than "I did not do this".
_Avoid_: Undo, delete, void (all imply the original row goes away; it never does)

**Seeded actual**:
A number one tap on ✓ writes for a Set metric the **prescription does not bound** (an open `{}`, rendered "report" / "report effort"), so the tap records the load lifted instead of a blank ([ADR 0021](docs/adr/0021-one-tap-confirm-seeds-an-unprescribed-metric.md), [#149](https://github.com/astefanovic/repcoach/issues/149)). Two tiers, tier 1 winning: the most recent actual for that metric on an **earlier Set of this Entry, this session** (pure, offline), then — the fallback — the most recent actual the **last time this Exercise was performed** (`lastActualForExercise`, a swap-aware, net-state read across finished Logged Sessions; online-only). The prescription outranks a seed, but not a **suggestion**: since the ADR's 2026-10-08 amendment every row, prescribed metrics included, first suggests what its counterpart Set lifted the last time the Exercise was performed, unless the plan has moved that metric since (an accepted Proposal's new load shows as prescribed). It is shown on the row *before* the tap as **`~N`, italic** — distinct from an upright prescribed ghost and from a seedless `–` — so the tap stays honest about what it writes. A convenience only: it never writes to the Plan, mints a **Change**, or touches the frozen prescription copy.
_Avoid_: Default, prefill, ghost (the ghost is the prescribed target; a seed is neither prescribed nor a target)

**Plan operation**:
One structural edit of the Plan, named from a closed set: `createSession`, `renameSession`, `deleteSession`, `orderSessions`, `addEntry`, `removeEntry`, `orderEntries`, `groupEntries`, `ungroupBlock`, `moveEntryToBlock`, `removeEntryFromBlock`, `setBlockParams`, `replaceEntrySets`, `setEntryExercise`, `orderBlocks`. Every Plan-authoring affordance is exactly one of these, they all travel through a single edit seam, and each accepted operation mints exactly one Change ([ADR 0015](docs/adr/0015-plan-authoring-is-one-operation-union.md)). Reordering and Set-list edits are **whole-value** — they carry the entire ordered list, never a positional move — which is what makes a retry after a dead spot safe.
_Avoid_: Action, command (a `commandId` is the idempotency key an operation travels with, not the operation), mutation

**Exercise catalog**:
The per-exercise metadata store: which metrics an exercise tracks, the muscles it trains, and its movement pattern. The join key that makes per-muscle volume and other analytics derivable from the Log. Not a hardcoded library, and **jointly authored**: the user may name any exercise (see **User-authored exercise**), but the coach defines every exercise's metadata — including its tracked-metric structure, which in turn **drives the logging field layout**, so a set row renders exactly the metrics the catalog declares for that exercise (a plank shows duration, a carry shows load + distance, no fixed reps/load layout). Catalog metadata is a **fact, not a Decision**: the coach writes it plainly, without a Proposal or an entry in the Decision log ([ADR 0016](docs/adr/0016-user-authored-exercises-are-name-only-rows-the-coach-enriches.md)). A row's id is permanent — rows are renameable but never deleted, because past Logged Sessions reference them.
_Avoid_: Exercise library, database

**User-authored exercise**:
A catalog row minted by naming an exercise the catalog did not hold — usable in the Plan the instant it exists, carrying **only that name**. Both authors can mint one: the **user**, by typing a name (the case this term is named for), and the **coach**, either in an accepted Intake draft or through a Proposal's declared new Exercises. Whoever mints it, the row must exist before an Entry may reference it — an `exerciseId` that joins to no row is refused, never silently applied. The coach **enriches** it (muscles, movement pattern, tracked metrics) on the next Session review, silently and with no on-screen marking; until then the exercise joins to no muscle, so its volume reads as zero. Because analytics are derived rather than stored, enrichment repairs that history rather than leaving a hole. Creating one is not a **Plan operation** and mints no **Change** — the Plan did not change — so adding a new exercise to a Session is two writes, and it is available only while connected ([ADR 0016](docs/adr/0016-user-authored-exercises-are-name-only-rows-the-coach-enriches.md)).
_Avoid_: Custom exercise, ad-hoc exercise, unknown exercise
