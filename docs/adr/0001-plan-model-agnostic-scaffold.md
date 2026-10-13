# The Scaffold is Plan-model-agnostic

RepCoach's data scaffold must represent *any* weight-training plan, because Claude has authority to choose and switch the training structure based on evidence and the user's data — linear, undulating, block/mesocycle, or non-cyclic autoregulation. We therefore do **not** model periodization concepts (mesocycle, microcycle, deload) as first-class schema entities. Instead the Scaffold fixes only a universal log shape — `Session → Block(format) → Entry(exercise) → Set(metric map + set-type)` — and the strategy that determines structure and "what's the next Session" lives in a **Plan model**: Claude-authored declarative data the app interprets, never logic hardcoded into the app.

## Considered Options

- **First-class periodization schema** (explicit mesocycle/deload entities). Rejected: bakes one training philosophy into the data model and caps the coach at the structures we anticipated — the exact "limited by built-in context" failure the product rejects.
- **Free-text / opaque plan blob.** Rejected: not inspectable or explainable, breaking the auditability the product is built on.

## Consequences

- `Set` is a metric map (`{reps?, load?, duration?, distance?, rpe?, tempo?}`), not reps×load — time- and distance-based work fit the same shape.
- `Block` carries a format (straight / superset / circuit / EMOM / AMRAP); a plain straight Block is implicit and hidden in the UI.
- Switching the Plan model is a Change, and therefore surfaces as a Proposal.
- Analytics (volume, e1RM, per-muscle sets) are *derived* from the Log joined against the Exercise catalog — never stored.
