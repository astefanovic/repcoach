# Design backlog — un-grilled branches

Open design branches not yet resolved. Each entry is framed to **cold-start a new grilling session** (`/grill-with-docs`): it states the question, why it matters, and what's already decided that constrains the answer. Resolve one per session; capture outcomes in `CONTEXT.md` (terms) and `docs/adr/` (hard-to-reverse decisions), then tick it here.

Read first for context: [CONTEXT.md](../../CONTEXT.md) and all of [docs/adr/](../adr/). The unifying principle: **the app is a generic Scaffold + seeded evidence; the coach owns every domain decision, grounded in research and the user's data.**

**Resolving a branch by accepting a named risk?** That belongs in [uat-watchlist.md](./uat-watchlist.md) — the mirror of this file. Here: *not yet decided*. There: *decided, but on a guess, and only real use will tell*. Offer the entry at the point the risk is accepted; don't write one silently.

---

## 1. Logging UX (mid-workout)

- [x] **Resolved** — see [ADR 0006](../adr/0006-logging-is-pure-actual-capture.md), the sharpened `Set` / `Change` / `Exercise catalog` terms in [CONTEXT.md](../../CONTEXT.md), and the filled-in "Logging (in-workout)" surface in [ui-surfaces.md](./ui-surfaces.md).

How the user logs a session at the gym — fast, glanceable, offline.

**Why it matters:** this is the most-used surface and the data layer everything else reasons over. Friction here kills the whole app.

**Already decided (constraints):**
- Local-first, written to SQLite immediately, offline-tolerant ([ADR 0004](../adr/0004-native-android-local-first.md)).
- The data shape is `Session → Block → Entry → Set` ([ADR 0001](../adr/0001-plan-model-agnostic-scaffold.md)); a plain straight `Block` is **hidden** in the UI until the user supersets/circuits (see `Block` in CONTEXT).
- A `Set` is a metric map ({reps, load, duration, distance, rpe, tempo}) with a set-type tag; special types (drop / myo-cluster / rest-pause) and timed `Block` formats (EMOM/AMRAP) must be loggable.
- The Plan provides a **prescription**; logging captures **actual** → the prescribed-vs-actual delta is the core signal ([ADR 0002](../adr/0002-deliberation-pipeline-not-live-chat.md)).

**To grill:** prescribed-vs-actual entry flow; rest timer; how special sets/timed blocks are entered without clutter; editing/backfilling past sessions; "deviation today" → does logging off-prescription auto-raise a Change?

---

## 1a. Minimal Plan structure (manual, pre-model)

- [x] **Resolved** — see [ADR 0007](../adr/0007-minimal-plan-is-degenerate-manual-plan.md) and [ADR 0008](../adr/0008-plan-changes-carry-origin-and-status.md), plus new/sharpened terms in [CONTEXT.md](../../CONTEXT.md) (**Session**, **Prescribed/Logged Session**, **Entry**, **Manual Plan model**, sharpened **Set** and **Change**) and the filled-in "Plan view" / "Today" surfaces in [ui-surfaces.md](./ui-surfaces.md).

The smallest hand-authored Plan that lets logging render prescribed-vs-actual (ghost text, one-tap confirm, prescribed rest, prescribed special sets/blocks). The prescription reuses the Scaffold (Session-shaped), copied into a Logged Session on start. **Unblocks** adding prescribed-vs-actual + a minimal Plan editor to the first issue batch.

**Left for later grilling** (each a future branch): Plan models proper (linear/undulating/block, deloads, cyclic Plan-view); Progression rules *firing*; binding session selection (weekday/rotation/scheduling; the "next up" hint is resolved by [ADR 0023](../adr/0023-next-up-is-a-derived-rotation-hint-not-a-schedule.md)); EMOM/AMRAP *authoring*; prescribed warmups; hard-constraint conflict handling on user edits. These layer onto the same Plan object — see "What it leaves for later" in [ADR 0007](../adr/0007-minimal-plan-is-degenerate-manual-plan.md).

---

## 2. Deliberation internals (prompt assembly)

- [x] **Resolved** — see [ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md), the new/sharpened terms in [CONTEXT.md](../../CONTEXT.md) (**Deliberation run**, **Adversarial sweep**, **Data window**, sharpened **Deliberation**, **Observation**, **Session review**, **Cycle review**, **Intake**), and the new "Deliberation run visibility" surface + updated Intake surface in [ui-surfaces.md](./ui-surfaces.md).

Resolution: a run is **one deliberator session + a one-way Adversarial sweep** over a **thin, retrieval-first context** — no front-loaded data dump; native Claude Code tools (`sqlite3` over a *read-only DB snapshot* + web) let the agent pull what it needs; the runner owns the only write-back into the existing `decision`/`coaching_feed_entry` tables (the 2A seam). The Log/analytics-slice question dissolves into "thin seed + agent pulls on demand." Citations are forced real by the sweep reading every source (claim-support) and rewriting the draft (strip/downgrade/degrade-to-uncited, never fabricate). Observation→Proposal accumulation lives in the Decision log with a **soft, prompt-guided bar** (no counter). Two cadences are one runner with two prompt framings and no structural lanes (Session review on **Finish Workout**, Cycle review **monthly**, model-per-cadence in settings). Intake is a distinct **interactive** cold-start run. Budget degrades by **deferral queue only**; "auditable" means **provenance-reconstructable (Data window + citations), not reproducible**.

**Deferred to future branches:** Plan-model-defined Cycle boundaries (superseding the monthly cadence) once non-Manual models exist; corpus→prompt *selection* if the Evidence base ever outgrows full-inject ([ADR 0003](../adr/0003-evidence-sourcing-corpus-then-retrieval.md) §5).

---

## 3. Seeding the Evidence base

- [x] **Resolved** — [ADR 0003](../adr/0003-evidence-sourcing-corpus-then-retrieval.md) revised to *minimal seed floor, retrieval-as-norm, corpus grows by promotion*.

Resolution: seed is a **minimal floor** (not 15–25), admitting only principles that are both *load-bearing on the coach's first decisions* AND *settled-enough-to-need-no-retrieval*; its size is an output of that test rather than a target. Entry shape `claim`/`source`(review-tier fine for seed)/`applicability`/`trust`. Retrieval carries most citations, restricted to checkable scientific sources with a real URL (degrade to "reasoning-only, uncited" rather than fabricate). Promotion is human-gated via a batch queue, triggered by a `retrieved-unverified` source being cited in an accepted Proposal. Corpus lives server-side; citations are value-snapshots on synced Decisions; full-inject the compact claim roster with no cap (corpus→prompt selection at scale deferred to §2).

- [x] **Seed authored and vetted** (issue #12) — [`docs/evidence/evidence-base-seed.md`](../evidence/evidence-base-seed.md) + JSON twin is the **working seed**: seven entries, all `corpus-verified`, sources vetted 2026-07-25. Authoring fed four amendments back into ADR 0003 (size and admit-list were gestures not bounds; test (a) is broader than *authoring*; the "minimal frequency" admit does not survive the evidence; §4's promotion gate is a *runtime* gate and does not govern the seed).

**Remaining near-term deliverable:** none here — wiring the corpus into a store and the deliberation prompt is coaching-layer work, tracked under §2.

---

## 4. What happens when you push back on a Proposal

- [x] **Resolved** — see [ADR 0013](../adr/0013-revise-user-invoked-amendment-of-a-drafted-decision.md), the new terms in [CONTEXT.md](../../CONTEXT.md) (**Revise**, **Revision run**, **Answer**, **Proposal lineage**; sharpened **Proposal**, **Decision**, **Deliberation run**), and the filled-in "Proposal card" surface in [ui-surfaces.md](./ui-surfaces.md). Ticket: [#60](https://github.com/astefanovic/repcoach/issues/60).

Resolution: the affordance is **Revise**, and it **ships in the first shell** rather than being cut or shipped inert — a dismissed Proposal records *that* you declined, a revised one records *why*. A Revise fires a **Revision run**: the Session-review runner under a third prompt framing (same seed, snapshot, tools, sweep and configured model, plus the target Decision and prior exchange), emitting **one Answer + at most one revised Proposal**. A revision **supersedes** the original — the agent judges, the **runner enforces scope** so a directive can only touch the Proposal the run was invoked against. Off-subject emissions are discarded; new Observations are kept but unsurfaced. Multi-turn is **sequential and uncapped**, one run in flight, with the card **locked behind a spinner** (queued vs running) and **Cancel** as the only escape. The exchange belongs to the **Proposal lineage**, folded under the head on Today and flat in Coach. A revision may **bundle a Standing-constraint promotion**, which the card must disclose. Fits [#42](https://github.com/astefanovic/repcoach/issues/42)'s IA constraint: in place on the card, no navigation, no chat destination.

**Amends [ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md)** in three places (§4 lanes, §5 `superseded`, §7's config list) — see ADR 0013's "Amendments" section.

**Left open, deliberately:** no turn cap, so a long argument can consume quota and defer a Session review (watch it when daily-driving); whether **Dismiss** should also carry an optional one-line reason for the "no, and I'm not arguing" case.

---

## 5. The Intake takeover, end to end

- [x] **Resolved** — see [ADR 0014](../adr/0014-intake-one-held-open-run-swept-once.md), the sharpened **Intake** and **Calibration phase** terms in [CONTEXT.md](../../CONTEXT.md), and the "Settled by the grilling" section on the Intake surface in [ui-surfaces.md](./ui-surfaces.md). Ticket: [#64](https://github.com/astefanovic/repcoach/issues/64).

What the one-time cold-start takeover looks and behaves like: the structured form, the interactive pass, waiting without a status strip, the calibration message, the handoff to Today, and failure states. Graduated from the map's *per-surface specs* fog once [#43](https://github.com/astefanovic/repcoach/issues/43) and [#42](https://github.com/astefanovic/repcoach/issues/42) landed.

Resolution: the form asks **only what a model cannot guess** (Goal, days/week, equipment, skippable weights) and pushes every judgment call into the pass. The pass is **not Revise** — **Intake is one run with many turns, Revise is N runs of one turn each**, because ADR 0013's heavy per-turn seed exists to re-read a Log that does not exist at cold start. A held-open deliberator session, cheap turns, coach-initiated questions with quick-reply chips, provisional citations, **nothing written until convergence**. Waiting is two different waits with a real-event activity line and a provenance footer; **Intake is exempt from ADR 0011 §8's deferral queue** as the only user-blocking run. Convergence (**"Review the sources"**) is a distinct act that fires the **single** Adversarial sweep; the swept output is the real Proposal card, **discloses what verification changed**, and only then can be Accepted — creating the Plan and exiting to a populated Today. Calibration lands with the first draft and nothing persists on Today. Failure fails loudly everywhere; a **gutted-but-honest plan is still acceptable**; drafts never persist across reload.

**Amends [ADR 0011](../adr/0011-deliberation-internals-run-mechanics.md)** in two places (§7 interactive shape, §8 deferral) — see ADR 0014 §9.

**Left open, deliberately:** whether the calibration phase earns any post-Intake presence on Today/Progress; whether the "what verification changed" disclosure should generalize to every Proposal; and whether **Revise** itself should become a lightweight thread-appending channel (raised here, deliberately *not* decided as a side effect of an Intake ticket).

---

## Resolved (for reference)

Core architecture is settled — see the ADRs:
- Plan-model-agnostic Scaffold ([0001](../adr/0001-plan-model-agnostic-scaffold.md))
- Deliberation pipeline, not live chat ([0002](../adr/0002-deliberation-pipeline-not-live-chat.md))
- Evidence sourcing ([0003](../adr/0003-evidence-sourcing-corpus-then-retrieval.md))
- Native Android, local-first ([0004](../adr/0004-native-android-local-first.md))
- Deliberation on Agent SDK + subscription, home-server runner ([0005](../adr/0005-deliberation-on-agent-sdk-subscription.md))
