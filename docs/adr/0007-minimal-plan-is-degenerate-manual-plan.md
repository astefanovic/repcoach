# The minimal Plan is a degenerate "manual Plan"; the prescription reuses the Scaffold

To unblock logging's prescribed-vs-actual UX (ghost text, one-tap confirm, prescribed rest, prescribed special sets/blocks) without building the full planning system, we define a **minimal Plan**: an ordered list of **Prescribed Sessions** under the **Manual Plan model** (user-authored, manually selected, no progression rules, no cyclicity). Crucially, a prescription is **Session-shaped** — it reuses the exact `Session → Block → Entry → Set` Scaffold ([ADR 0001](./0001-plan-model-agnostic-scaffold.md)), with each prescribed `Set` carrying a target metric map (intervals) instead of a logged actual. Starting a workout **deep-copies** the chosen Prescribed Session into a Logged Session; logging fills the actual side; prescribed-vs-actual is then a row-for-row alignment of one tree, not a join between two different shapes.

## Why this shape

The product's core signal is prescribed-vs-actual ([ADR 0002](./0002-deliberation-pipeline-not-live-chat.md)). If the prescription is the *same* tree as the log, that signal — plus ghost text, one-tap confirm, deviations, swaps, skips, unplanned work — falls out structurally at **every node**:

- **Set**: prescribed target interval (`{min?,max?}`) vs logged scalar → "below/in/above range".
- **Entry**: prescribed exercise vs actual exercise → a **swap** (and because the Logged Session is a copy, the prescribed exercise is retained inline, so swap-provenance is free).
- **Block**: prescribed format/params vs what was actually done.

A skip is a node with a prescribed side and no actual; unplanned work is a node with an actual side and no prescribed. The Prescribed Session is just the degenerate "prescribed-only, no actuals" case of the same types.

## Considered Options

- **A separate, flatter prescription structure** (e.g. per-Entry `{exercise, sets:N, repTarget, loadTarget, rest}`). Rejected: it is a *parallel* structure to the Log Scaffold, so the delta becomes a join and per-set variation (ramps, top-set+backoff, drop sets) needs a side-channel of overrides — exactly the throwaway parallel structure the model-agnostic bet ([ADR 0001](./0001-plan-model-agnostic-scaffold.md)) exists to avoid.
- **Count + single target instead of a Set list** (`sets: 4, reps: "8–10"`). Rejected: cannot express ramps, prescribed warmup ladders, or drop/rest-pause phases without a parallel override mechanism. A prescribed Entry therefore holds an **ordered list of prescribed Sets**; "4×8–10" is editor sugar that expands to four identical rows.
- **Weekday assignment / rotation for "today's Session".** Rejected for minimal: a weekday map asserts weekly **cyclicity**, which CONTEXT forbids the Scaffold from assuming ("a Plan is not assumed to be cyclic"). Choosing the next Session is the Plan model's job; the Manual model's answer is **manual pick** from the ordered list. The order is benign data (a sequence is not a cycle); binding auto-advance/scheduling is deferred to a future cyclic model.

## What the minimal Plan achieves

It is the smallest Plan that makes every promise of the already-resolved logging surface ([ADR 0006](./0006-logging-is-pure-actual-capture.md), the "Logging" surface in [ui-surfaces.md](../design/ui-surfaces.md)) **renderable against a real prescription** — i.e. it turns logging from pure capture into prescribed-vs-actual capture. Concretely it delivers:

- **A prescription to ghost.** Each prescribed Set's target map renders as ghost text; one-tap confirm copies target → actual (for a ranged rep target, top-of-range; type to deviate).
- **Rep ranges** (`{min?,max?}`), needed for ghost text and double-progression-style training, plus exact targets, open "8+", and "≤ RPE 8" caps — one uniform interval type across all metrics.
- **Autoregulated prescription** for free (sparse target map: prescribe reps only, or reps+RPE with no load).
- **Prescribed per-Set rest**, read by the logging rest timer (absent = no timer).
- **Prescribed special sets** (drop / rest-pause / myo-cluster) via adjacency + set-type + near-zero rest — logging auto-renders them, no new structure.
- **Prescribed Block formats** superset + circuit (rounds = index-aligned Set lists).
- **A manual authoring surface** (the minimal Plan view): CRUD on the ordered list of Prescribed Sessions and, within one, add/remove/reorder Entries from the Exercise catalog, group into superset/circuit Blocks, and edit each prescribed Set list (with "N identical sets", per-set rest, and add-special-set sugar). This is the **only** Plan-authoring path now that Intake is excluded — the first Plan is born from its empty state.
- **Manual "today's Session" selection** from the ordered list; picking one instantiates the Logged Session.
- **Forward-compatibility**: the minimal Plan *is* the same Plan object the future Plan model, Progression rules, and Deliberation will author and mutate — not a throwaway. The model layer arrives as a model-switch Change ([0008](./0008-plan-changes-carry-origin-and-status.md)) over the same Scaffold.

## What it deliberately leaves for later grilling

The minimal Plan holds **static, user-authored prescriptions only**. Out of scope here, each a future grilling branch (see [open-questions.md](../design/open-questions.md)):

- **Plan models proper** — linear / undulating / block periodization, mesocycles, deloads, and the cyclic Plan-view visualization (the weekday grid / "accumulation week 3 of 6" in the design mockup). The Manual model is the only model for now.
- **Progression rules firing** — the Scaffold names them, but no rule resolves targets from performance yet; all targets are hand-entered.
- **Binding session selection** — weekday assignment, rotation/auto-advance, scheduling. ~~And the optional order-derived "next up" hint on Today (deferred even though the order is stored).~~ The hint is now resolved by [ADR 0023](./0023-next-up-is-a-derived-rotation-hint-not-a-schedule.md): a non-binding rotation hint on Today; weekday assignment stays deferred.
- **Coach-authored Plan edits** — Deliberation, Proposals, the Decision log's read side, Session/Cycle review. (User-direct Changes *are* persisted now per [0008](./0008-plan-changes-carry-origin-and-status.md), but nothing reads them yet.)
- **Intake / seeding** — the cold-start that would otherwise author the first Plan.
- **EMOM / AMRAP authoring** — the data shape and logging support them (open-ended rounds = appended actuals in the editable copy), but the minimal editor does not prescribe them; superset/circuit only.
- **Prescribed warmups** — the model allows `warmup`-tagged prescribed Sets; the minimal editor authors working sets only.
- **Hard-constraint conflict handling** on user edits (warn-don't-block) — deferred.

## Consequences

- One `Set` / `Entry` / `Block` type each serves both prescription and log; the actual side is optional. CONTEXT's `Set` is sharpened to two metric maps.
- Editing a Prescribed Session never affects past or in-flight Logged Sessions (they are deep copies taken at start).
- "One-tap confirm on a ranged target resolves to top-of-range" is a logging-surface convention (noted in [ui-surfaces.md](../design/ui-surfaces.md)), not a Plan-shape rule.
