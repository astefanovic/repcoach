# Deliberation internals: a two-agent run over a thin, retrieval-first context

How a Deliberation run is actually assembled and executed on the home-server
Agent SDK ([ADR 0005](0005-deliberation-on-agent-sdk-subscription.md)),
resolving the last open core design branch
([open-questions §2](../design/open-questions.md)). This ADR fixes the
**run mechanics**; it does not re-litigate that Deliberation is ahead-of-time
([ADR 0002](0002-deliberation-pipeline-not-live-chat.md)), that evidence is
seed-floor + retrieval-as-norm ([ADR 0003](0003-evidence-sourcing-corpus-then-retrieval.md)),
or that it runs on the Agent SDK under subscription OAuth (ADR 0005) — those
bound the decisions below.

The **2A seam** is the target: a run is a *producer of rows* in the existing
persistent store — `decision(id, kind, origin, status, summary, rationale,
citations_json, data_window_json, created_at)` and `coaching_feed_entry(id,
kind, summary, created_at, proposal_id)`. The display path (the client's
`subscribeCoachingFeed`/`subscribeProposals`) is already done. **This is a
design decision record, not a build plan** — the runner/scheduler build is a
downstream 2B handoff that plugs into this seam.

## Decision

### 1. A run is one deliberator session + a one-way adversarial sweep
A Deliberation run is **a single Agent SDK (Claude Code) session** — the
deliberator — with a generous "within reason" turn/wall-clock budget and a
hard runaway-kill. It does its own reasoning and its own retrieval. It is **not**
an orchestrated multi-stage ETL pipeline (that would fatten the call site and
fight the ADR 0005 "keep it thin" seam).

The deliberator's draft then passes through a **short adversarial agent** that:
- **fetches and reads each cited source** (claim-**support** verification, not
  merely "the URL resolves");
- **rewrites the drafted Decision in place, one-way** — no negotiation loop
  back to the deliberator. It strips unverifiable citations, downgrades trust
  levels, and where a Proposal's evidentiary basis collapses it **rewrites the
  Proposal down to an Observation or a "reasoning only, uncited" point.**

**The adversarial agent's output _is_ the committed Decision** — the runner
parses *its* output, never the deliberator's draft. This is the structural
trust floor (ADR 0002/0003): a Decision cannot ship a citation the sweep did
not read and confirm. Degrade-to-uncited, never fabricate.

### 2. Thin seed context; the agent retrieves the rest with native tools
The run does **not** front-load the Log, full analytics, and Decision log.
Context is kept short and the agent **pulls more as it needs it**. The
**seed** (always injected, compact) is:
- the **run header** — cadence, current Plan snapshot (Plan model + prescribed
  sessions), Goal + chosen proxies;
- **all Standing constraints** (hard/soft) — *injected, not pulled*: a hard
  constraint missed because the agent didn't think to query is a safety
  failure, so it is never left to on-demand retrieval;
- the **Evidence-base roster** — the compact `claim` lines per ADR 0003's
  full-inject rule;
- recent **Check-ins / Context notes** (small, always relevant to recovery);
- a small **pointer digest** ("N sessions since last review, M open
  Observations, last Cycle review at …") to orient what's worth pulling.

**No custom tool surface.** The Agent SDK *is* Claude Code, which already ships
`Read`, `Bash` (`sqlite3`), `Grep`, and `WebSearch`/`WebFetch`. Building custom
MCP tools would re-invent those and add surface area that can inadvertently
degrade native behaviour. Instead the seed carries **plain-language pointers +
a compact data dictionary** (table→columns) naming the SQLite DB and how to
query it. Derived analytics are **not** precomputed — the agent computes what
it needs with SQL/reasoning (acceptable at personal scale).

### 3. The agent reads a read-only snapshot; the runner owns the only write
Handing a free-reasoning agent a `Bash`+`sqlite3` shell over the **live**
production DB is unacceptable — a reasoning slip or a malformed query could
`UPDATE`/`DROP` real logged data (the same reason the prod server strips its
`/__test__` reset channel, [ADR 0010](0010-persistent-home-server-serves-web-client.md)).
So: the run's pointers target a **read-only snapshot** (a pre-run copy, or an
open with `PRAGMA query_only`). The agent has **no write path**. The **only**
write-back is the runner parsing the adversarial agent's structured output and
performing the inserts/updates itself.

*Accepted consequence:* using native filesystem/bash tools makes the ADR 0005
"Messages API drop-in fallback" seam less literal — a fallback would re-plumb
retrieval as Messages-API tool-use. The thin seam is read as living at
**"assemble prompt → parse structured Decision out,"** with tool *access*
differing per backend.

### 4. Two cadences = one mechanism, two prompt framings (no structural lanes)
> **Amended by [ADR 0013](0013-revise-user-invoked-amendment-of-a-drafted-decision.md) §7.** "No structural lanes" now scopes to *proactive survey cadences*. A **Revision run** is user-invoked and has a subject, so the runner filters its emissions (off-subject Proposals and directives discarded; new Observations kept but unsurfaced).

To start minimal, **both cadences may propose anything.** There is *no*
structural emission-authority difference. The **only** difference is the
prompt's focus:
- **Session review** — "focus on the current cycle / recent data." Fires when
  the user taps **Finish Workout** (an explicit workout-done event, not
  mid-workout set-syncs).
- **Cycle review** — "take the longer history into account." Runs **monthly**
  (a plain schedule). Plan-model-defined boundaries are a *later* refinement
  for when non-Manual models exist; today the only model is Manual (no
  cyclicity, hence no boundaries), so a fixed monthly cadence is the concrete
  trigger.
- **On-demand "run now"** is always available (ADR 0002).
- The **model per cadence is configurable in settings** — e.g. a cheaper/faster
  model for the frequent Session review, a stronger one for the rare Cycle
  review. Session-review restraint comes from that model choice + prompt tone,
  not an enforced turn cap.

*Consequence, named consciously:* with no structural lanes, the entire
**anti-twitchy guarantee rests on the Observation-accumulation mechanism (§5)
plus the adversarial sweep** — ADR 0002's "restrained Session review" is a
prompt-and-mechanism promise, not a structural one. Accepted for the minimal
start; revisit with structural lanes if a run ever proves twitchy in practice.

### 5. Escalation lives in the Decision log; the bar is soft
> **Amended by [ADR 0013](0013-revise-user-invoked-amendment-of-a-drafted-decision.md) §3.** `superseded` is **no longer reserved** for Change supersession: a **Revision run** may emit a scoped **`supersede`** directive. The runner honours it *only* for the Proposal the run was invoked against and *only* while that Proposal is `pending` — every other id remains a no-op, so the guard below still holds for all other cases.

Observation → Proposal accumulation has **no separate accumulator state**. Each
run queries **open Observations** (`kind='observation' AND status='open'`),
judges whether the fresh data + priors now constitute a real trend, and the
**bar is soft and prompt-guided** — *no* hardcoded "N Observations = escalate"
counter. A run's output is therefore **{new Decisions} + {status directives on
existing Observation ids}**. An Observation is born `status='open'`, and the
two directive actions map to exactly one terminal status each:
- **`escalate`** → the runner flips the Observation to **`escalated`** and the
  emitted Proposal references the supporting Observation ids;
- **`close`** (stale/contradicted) → the runner flips it to **`expired`**.

Directives act **only on Observation rows** (`kind='observation'`): a directive
that names a non-Observation id — e.g. a pending Proposal — is a **no-op**, never
a status flip. (This guard is enforced in the store and covered by the slice-1
adversarial suite; `superseded` is reserved for Change supersession under
[ADR 0008](0008-plan-changes-carry-origin-and-status.md), not a directive
outcome.)

Only `status` moves; `rationale`/`citations`/`data_window` stay immutable
(ADR 0002) — exactly how Proposals already resolve in place (ADR 0008).

### 6. Output contract: one JSON object the runner maps to rows
The adversarial agent emits a single structured object; the runner is a dumb,
reliable mapper that owns all machine fields:

```
{
  "decisions": [
    { "kind": "observation" | "proposal",
      "summary": "...",                 // → decision.summary + feed.summary
      "rationale": "...",               // → decision.rationale (layered prose)
      "citations": [ { "claim", "source_url", "trust" } ], // → citations_json (value-snapshots)
      "reasoning_only_points": ["..."], // honestly-labelled uncited points
      "surface": true|false             // Observations only: feed-worthy?
    }
  ],
  "observation_directives": [
    { "id": "<existing observation id>", "action": "escalate" | "close" }
  ]
}
```

The runner: assigns `id`/`created_at`; sets `status` (`observation`→`open`,
`proposal`→`pending`); sets `origin='coach-proposal'` for **every** coach-produced
row (read `origin` as **authorship**, so the `NOT NULL` column stays meaningful
for non-Change Decisions without a migration); inserts `decision` rows; writes
a matching `coaching_feed_entry` for **every Proposal** and for **Observations
only when `surface:true`** (keeps the feed signal-dense, the log complete);
applies the directives as status flips. The agent never sets
ids/status/timestamps.

`citations_json` = value-snapshots (`claim` + `source_url` + `trust` as-of-now,
ADR 0003). `data_window_json` = the provenance envelope
`{ cadence, ran_at, window_from, window_to, session_ids_considered,
evidence_roster_version }`.

**Amended by [#79](https://github.com/astefanovic/repcoach/issues/79)
(migration 008): three optional fields carry the *working*.** A decision may
also emit `measurements` (`[{ label, series, delta }]` — the numbers the claim
rests on, already formatted for reading), `rule` (the single named principle
that fired), and `uncertainty` (the concrete observation that would overturn
this). They exist because CONTEXT's Decision log promises a layered account —
"deeper evidence and the rule that fired underneath" — and only the top layer
was storable; the surface that renders them was fixture-fed until this landed.

All three are **optional, and absence is meaningful**: a run with nothing
honest to put in a slot omits it and the card renders one fewer block. Nothing
on the write or read path may soften an omission into `[]` or `""` — that would
make "the coach offered no evidence" indistinguishable from "the coach offered
empty evidence", and a block that always appears teaches the user to skip it.
The sweep (§1) echoes these back untouched: they are not citations, so they are
not its to verify, strip or improve.

**Amended by [#94](https://github.com/astefanovic/repcoach/issues/94): the
object is read tolerantly, and an unreadable one buys exactly one repair
turn.** "One JSON object" stays the contract — nothing below softens what the
object must contain. What changes is how the object is got out of the model's
final message: prose either side of it, and any fence variant, are recovered
rather than fatal, for all four agents through one shared extraction. A message
that still cannot be read buys **one** repair turn (no tools, one turn, two
minutes, second failure terminal) that is told to re-emit and forbidden to
re-reason; its tokens are summed onto the same run's ledger row. An output that
survives neither is a **typed** failure naming which way it failed — the run
fails, and nothing part-formed is committed.

The bar it must not cross is §6's own: the repair asks for the same content in
the right shape, never for different content. It may not fill a hole with an
invented citation, source or number, and the three *working* fields are never
defaulted by any of this — "the coach offered no evidence" has to stay
distinguishable from "the coach offered empty evidence" no matter how the
message was wrapped. See `docs/ops/repcoach-server.md` for the live deviations
that motivated the shape, and UAT watchlist entry 7 for the part of it that is
still only reasoning.

### 7. Intake is a distinct, *interactive* cold-start run
> **Amended by [ADR 0013](0013-revise-user-invoked-amendment-of-a-drafted-decision.md) §6.** There is now a **third prompt framing on the review runner** — the **Revision run**, fired when the user Revises a Proposal. Intake remains the only *distinct configuration* and the only interactive run; a Revision run is fire-and-forget like the two review cadences, and shares the Session review's seed, tools, sweep and configured model.
>
> **Amended by [ADR 0014](0014-intake-one-held-open-run-swept-once.md) §9.** The interactive shape below is now specified: Intake is **one held-open deliberator session resumed across turns** — not a sequence of runs — with **one Adversarial sweep at convergence** rather than per turn, and **no Decision rows written until convergence**. Converging ("Review the sources") is a **separate act from Accept**, and the swept output is what the user accepts. *Intake is one run with many turns; a Revision run is one turn.*

With no Log/analytics/prior Decisions, **Intake** is a third run configuration
and the **one interactive one**: its seed is the Intake structured form
(days/week, equipment, lifts + working weights) + the raw Goal, and it
**converses** — drafts a first Plan, presents it ("What do you think of this
plan?"), the user tweaks on the fly, the agent revises, converges, and emits
the **first Plan as an accept-able Proposal + a documenting Decision** (Plan
mutates only on accept). The adversarial citation sweep still runs on the final
plan. The Calibration-phase caveat is stated honestly in that first Decision.

This stays **within ADR 0002**, not against it: the agent **drafts the Decision
first, then interrogates/amends it conversationally** — the chat is shaping a
drafted Decision, not originating coaching from a blank slate. It is the only
live loop and is bounded to the cold start.

### 8. Budget: deferral only; audit means provenance, not reproduction
> **Amended by [ADR 0014](0014-intake-one-held-open-run-swept-once.md) §9.** "Nothing is user-blocking" holds for the three fire-and-forget cadences only. **Intake is the counterexample and is exempt from the deferral queue**: it is user-blocking, abandonable (so "come back later" means "start over"), and the first thing a cold user does. A quota-starved Intake **fails loudly** with a retry and a pointer to the manual Plan path, rather than queuing.

- **Degradation ladder = a deferral queue, and nothing else** (for now).
  Deliberation is ahead-of-time and proactive, so **nothing is user-blocking**:
  when subscription quota (ADR 0005 rolling/weekly) is low, a run **queues and
  fires when quota frees up** — late costs nothing. No coalescing, no
  retrieval-skipping, no Messages-API fallback yet. **The adversarial sweep is
  never skipped to save budget** — a run that can't afford its sweep defers.
- A **run-visibility UI** shows active/queued runs and **token usage** (under
  subscription OAuth this is token *counts* from the SDK, not a dollar bill).
  > **Amended by [#81](https://github.com/astefanovic/repcoach/issues/81).**
  > Live run state is not enough to judge spend, because it is a *last run*
  > snapshot that nothing accumulates. Cost is therefore **persisted per agent
  > session** in a run ledger — one row per `query()` session, grouped by run,
  > discriminated by stage (deliberator / sweep / intake draft / intake turn).
  > That grain is deliberate: a run is not one session, and the questions worth
  > asking are about the *composition* of a run's cost, not its total.
  >
  > Two corrections come with it. **Token usage is four numbers, not two** —
  > the SDK's `input_tokens` is the *uncached* remainder, with cache reads and
  > cache creations reported separately and priced roughly an order of magnitude
  > apart, so a two-field `{prompt, completion}` understates every run and
  > understates cached-heavy runs most. And **the adversarial sweep was never
  > counted at all**: its agent returned output without usage, so a permanent,
  > non-trivial share of every run's cost was invisible. Both are fixed here.
  >
  > Cost in **dollars** is available from the SDK (`total_cost_usd`, and
  > per-model `costUSD`) and is recorded, but is **not rendered**: under
  > subscription OAuth ([ADR 0005](0005-deliberation-on-agent-sdk-subscription.md))
  > it is imputed rather than billed, and the risks actually being watched are
  > quota risks. Storing it costs a column and avoids a migration if that ever
  > changes.
  >
  > The ledger write is the **runner's**, per §3 — the SDK session adapter stays
  > free of the store.
  >
  > **Amended by the Coach run history: the run gets a ROW, because two of
  > its states are otherwise unrepresentable.**
  >
  > §8 above asks for a run-visibility UI, and it was built (#32) off the
  > runner's live `RunState`. That is the right thing for a status strip and
  > the wrong thing for a record, and the gap only becomes visible once you
  > ask the record to show a run rather than a Decision:
  >
  > - **A run that emitted nothing writes nothing.** `commitDeliberationOutput`
  >   loops over the run's decisions, so a run that read the data and judged
  >   that nothing cleared the bar leaves no trace whatsoever. That run is
  >   §4's anti-twitchy mechanism doing exactly its job — and a mechanism
  >   nobody can see is one the user cannot calibrate trust against. **A coach
  >   whose restraint is indistinguishable from its absence is §4's own
  >   failure mode**, and the data model was producing it.
  > - **A run that failed forgets why.** `failureReason` (#90) lives on the
  >   in-memory `runStateRef`, which the next run overwrites and a restart
  >   discards, so "the coach has been quiet" and "the coach has been
  >   crashing" read identically a day later.
  >
  > Neither is derivable from rows that were never written. The cheaper
  > option — grouping committed Decisions on the `data_window_json` they
  > share — was considered and rejected for exactly that reason: it can only
  > ever reconstruct the runs that spoke.
  >
  > So a **Deliberation run is a row** (`deliberation_run`, migration 020):
  > cadence, status (`running`/`committed`/`failed`), failure reason, the
  > provenance envelope it assembled, and when it started and finished.
  > `decision.run_id` ties the Decisions to it.
  >
  > The two §3/§6 rules govern it, unchanged, and the run ledger already
  > follows both: **the runner is the only writer**, and **a failed write here
  > must never fail the run it is recording** — losing the record of a
  > Decision must not cost the Decision. The row is opened `running` *before*
  > the first agent session and closed after the commit, because a row written
  > only on success could never record anything but success.
  >
  > Three consequences worth naming rather than discovering:
  >
  > - **Nothing about a run survives the process**, so a row left `running` at
  >   startup describes a run that was killed. The runner closes those once, at
  >   boot; the alternative is a permanently pulsing live node, which is the
  >   surface asserting the coach is working when it is not.
  > - **A cancelled Revision discards its row entirely.**
  >   [ADR 0013](0013-revise-user-invoked-amendment-of-a-drafted-decision.md) §5
  >   says a cancelled Revision writes no rows, and this one is included:
  >   recorded as `failed` it would put a red node on the record for something
  >   the user themselves called off; recorded as `committed` it would claim an
  >   output deliberately never written.
  > - **`run_id` is nullable permanently.** Every Decision written before this
  >   has none, and the record reconstructs those runs from `data_window_json`
  >   — recovering the ones that spoke, honestly claiming nothing about their
  >   stages. A null `run_id` is history, not an error.
  >
  > Spend stays where §8 put it. The ledger row this record derives its stages
  > from carries model, tokens and cost, and none of the three is rendered
  > here: the record asks how the coach reasoned, Settings asks what it cost,
  > and merging them turns an explainability surface into a telemetry one.
- **"Auditable" = provenance-reconstructable, not output-reproducible.** The
  model is non-deterministic and the run is two agents doing free-form
  retrieval, so re-running won't reproduce a Decision. What is guaranteed: for
  any Decision you can see **what data window** (`data_window_json`) and **what
  evidence** (citation snapshots) produced it, and check the sources yourself —
  matching ADR 0003's "verification stays with the human." **No run-transcript
  record and no replay/seeded-RNG** — over-engineering for a personal tool.

## Considered Options
- **Multi-stage orchestrated pipeline** (separate retrieval / deliberation /
  verification model calls). Rejected: fattens the call site against ADR 0005's
  thin-seam constraint and fights ADR 0002's "grill→ADR flow" framing. The
  single-session + adversarial-sweep shape gets the verification guarantee
  without an ETL.
- **Forced citation-verification *tool* the deliberator must call.** Rejected in
  favour of a separate adversarial agent: an editor with final, one-way
  authority is a stronger, cleaner trust boundary than the same agent policing
  itself mid-reasoning.
- **Front-loading the full Log/analytics into the prompt.** Rejected: costs
  tokens against subscription limits and buries signal. Thin seed +
  retrieval-on-demand keeps context short and lets the agent scope its own dig.
- **Custom MCP tool surface over the store.** Rejected: Claude Code already has
  `Read`/`Bash`/`Grep`/web tools; custom tools add breakable surface area.
- **Structural emission lanes** (Session review structurally barred from
  originating Proposals). Rejected *for now* as premature structure; the soft
  bar + sweep carry anti-twitchiness at the minimal start.
- **Hardcoded escalation counter.** Rejected: trends aren't countable that
  cleanly; the agent + sweep are the judgment layer.

## Consequences
- **2B build is unblocked and scoped.** The downstream runner/scheduler build
  writes `decision`/`coaching_feed_entry` rows via this contract; the display
  path is untouched.
- **The read-only snapshot is load-bearing** — the runner must snapshot (or
  `query_only`-open) the DB before every run and must be the sole writer.
- **Anti-twitchiness is now a soft guarantee** (§4) — a known, accepted risk to
  revisit with structural lanes if needed.
- **Intake carries a UI cost** — an interactive chat-shaped cold-start flow, not
  a fire-and-forget run (see [ui-surfaces.md](../design/ui-surfaces.md)).
- **New surfaces implied:** a run-visibility/token-usage indicator and a
  per-cadence model setting (see ui-surfaces.md).
- **The run ledger is a schema and contract change, not a reporting feature**
  (§8 amendment, [#81](https://github.com/astefanovic/repcoach/issues/81)): a new
  table, a widened `TokenUsage` (four fields, `input`/`output` naming), and a
  signature change on the sweep agent so it stops discarding its own usage.
  It is what makes UAT watchlist entries
  [1 and 2](../design/uat-watchlist.md) answerable at all — both ask for
  per-run comparisons that no live run-state snapshot can supply.
- **Every cadence that resolves a model needs a selector.** §4 motivated the
  setting with Session vs Cycle review, and that framing was read as *only* two
  selectors — but `intake` and `on-demand` also resolve a model at run time, so
  two selectors leaves live cadences on an unconfigurable default. Four
  selectors; `revision-run` stays non-configurable by
  [ADR 0013](0013-revise-user-invoked-amendment-of-a-drafted-decision.md) §6 and
  says so on screen.
- **The monthly cadence is on the UAT watchlist**
  ([entry 5](../design/uat-watchlist.md)) — §4's "plain schedule" was built
  (#91) as a rolling 30 days claimed *before* the run fires, so a failed run
  costs a month rather than risking a crash-loop's worth of quota. Both halves
  are reasoned, not evidenced; daily-driving settles them.
- **Output-shape recovery is on the UAT watchlist**
  ([entry 7](../design/uat-watchlist.md)) — §6's tolerant extraction is free and
  needs no watching, but the **one repair turn** behind it fires against drift
  nobody has observed (commissioning saw none in five live sessions,
  `docs/ops/repcoach-server.md`). Whether it ever fires, and whether it helps
  when it does, is a daily-driving question; the fallback is deleting it and
  keeping the extraction.
- **The run itself is now a row, not just a live snapshot** (§8 amendment, the
  Coach run history): `deliberation_run` (migration 020) plus a nullable
  `decision.run_id`, written only by the runner and only best-effort. It is what
  makes a run that emitted nothing and a run that failed sayable at all — both
  were previously invisible by construction — and it is what turns the Coach
  surface from a list of Decisions into the record of the coach's deliberating
  (see [ui-surfaces.md](../design/ui-surfaces.md) → *Settled by the prototype*).
- **Deferred to a future ADR/branch:** Plan-model-defined Cycle boundaries
  (superseding the monthly cadence) once non-Manual models exist; corpus→prompt
  *selection* if the Evidence base ever outgrows full-inject (ADR 0003 §5).
