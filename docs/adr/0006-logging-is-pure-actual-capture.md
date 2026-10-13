# Logging is pure actual-capture; it never mints a Change

The in-workout logging surface records **actual** performance only. An off-prescription log — 7 reps instead of 8, a dropped set, an exercise swap — is captured as a prescribed-vs-actual delta that is pure data; it never auto-creates a [Change](../../CONTEXT.md). A Change has exactly two origins: a Deliberation Proposal the user accepts, or the user editing the Plan directly outside a workout. We chose this so the gym-floor surface stays single-purpose and can't accidentally mutate the Plan, and so deviations flow through the non-twitchy review path (deviation → Session review → Observation → trend → Proposal) that [ADR 0002](./0002-deliberation-pipeline-not-live-chat.md) established.

## Considered Options

- **Flag deviations as Changes at log time** (a logged 4×7-vs-4×8 immediately raises a Change). Rejected: a Change is forward-looking and requires approval, but a logged actual already happened — there is nothing to approve. It would also make the coach twitchy, minting plan churn from single-session noise.
- **Offer a "make this permanent" affordance in the logging surface** to promote a deviation into a Plan edit. Rejected: keeps the door open to accidental plan mutation from a single gym-floor tap; plan edits belong on the Plan view, done deliberately outside a workout.

## Consequences

- The Log is trusted to be pure actual everywhere downstream; Deliberation reasons over prescribed-vs-actual without worrying that logging pre-decided anything.
- There is **no** plan-editing affordance in the logging UI. Permanent changes are made on the Plan view.
- Backfilling/editing a past Session may re-trigger its Session review (the prior review reasoned over now-stale data) — treated as a soft preference, not a hard requirement.
