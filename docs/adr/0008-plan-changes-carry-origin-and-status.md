# Plan Changes carry origin + status; user-direct edits auto-apply, coach Changes are approval-gated

Every Change to the Plan records an **origin** (`user-direct` vs `coach-proposal`) and a **status** (`pending` / `accepted` / `rejected` / `applied` / `superseded`). A **user-direct** edit (the user authoring the Plan on the Plan view) is **auto-applied** with no approval step — you do not approve your own edit, so it is born `applied`. A **coach-proposal** is approval-gated: it stays `pending` until the user `accepts` (then it mutates the Plan) or `rejects` it — and a rejected Proposal is **retained**, not discarded. We persist user-direct Changes from day one even though the coaching layer that will read them does not exist yet.

## Why

Changes exist to give the coach memory of the Plan, for two purposes: (1) a history the LLM reasons over for trends/past behaviour, and (2) a record of what the coach offered and the user accepted or declined — Proposals are "ADRs for the Plan," valuable even in rejection. Both purposes need the two axes:

- **Origin** keeps the LLM from confusing *"the user did this themselves"* (a revealed-preference signal) with *"I, the coach, decided this"* (its own prior decision). Without it the history is ambiguous.
- **Status** is what makes a rejected Proposal a first-class, retained record rather than a deletion, and what distinguishes an applied edit from a pending offer.

Auto-approving user-direct edits has no real downside given origin is stamped: the edit is still fully recorded (purpose 1 intact), and a user's own edit has no "rejected" state to lose (purpose 2 is about coach Proposals). Gating it would just be friction — approving your own typing — with no safety benefit, since the user is the author.

Auto-approved is **not** unreviewed: a user-direct edit is to the Plan what a logged deviation is to a Session — an action the coach does not *block* but reasons over afterward and may answer with a Proposal, consistent with the ahead-of-time pipeline ([ADR 0002](./0002-deliberation-pipeline-not-live-chat.md), [ADR 0006](./0006-logging-is-pure-actual-capture.md)).

## Considered Options

- **Gate all Changes (including user edits) behind approval.** Rejected: incoherent (you cannot meaningfully approve your own edit) and pure friction.
- **Don't record user-direct edits / discard rejected Proposals.** Rejected: destroys exactly the history both purposes depend on — substitution/avoidance patterns (a behaviour the coach already promotes into Standing constraints) and the record of declined coaching.
- **Defer all Change persistence with the rest of the coaching layer.** Rejected: persisting user-direct Changes is a trivial append needing no coach to write, and recording from day one avoids a cold-start with zero Plan-history when Deliberation lands.

## Consequences

- This sharpens CONTEXT's `Change`: "raised for the user's approval" now scopes to **coach-proposal** origin only; user-direct edits skip the pending/accept dance.
- The minimal Plan editor writes a `user-direct`, `applied` Change on each edit. Nothing reads these yet; they accumulate for the future Decision log / Deliberation.
- A user edit that conflicts with a **hard** Standing constraint is allowed (the Plan is the user's) and will later **warn, not block** — deferred past the minimal Plan.
