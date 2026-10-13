/**
 * The ADR 0015 Plan-operation union, described for an agent (issue #86).
 *
 * A coach Proposal must carry **the Change it proposes**, and it carries it in
 * the same operation union a user-direct Plan edit travels in — one applier,
 * one set of structural rules, the coach held to the same validation the user
 * is. That makes this text a producer-side contract document: it is the only
 * thing standing between "the agent knows the vocabulary" and a Proposal whose
 * operations are rejected at Accept.
 *
 * Stated ONCE and shared by the deliberator prompt and the sweep prompt (which
 * echoes operations back untouched), because a sweep working from a different
 * description of the union than the deliberator emitted against is a rewrite
 * waiting to happen — and ADR 0014 §5 is explicit that the sweep governs the
 * justification, never the prescription.
 */
export const PLAN_OPERATION_VOCABULARY = `
### The Plan operations you may propose

A Proposal must carry the change it proposes, as \`plan_operations\`: an ORDERED array of operations applied
one after another to the Plan exactly as it appears in the "Plan snapshot" above. They are applied
ALL-OR-NOTHING — if any one of them does not validate against the standing Plan, nothing is applied and the
user is shown a rejection instead of your change. Name only ids that appear in the Plan snapshot, and invent a
fresh unique id (any distinct string) for anything you create.

Every operation is \`{ "_tag": "<name>", ... }\`:

- \`{ "_tag": "createSession", "sessionId": "<new id>", "name": "Lower B" }\` — an empty Session appended to the Plan.
- \`{ "_tag": "renameSession", "sessionId": "<existing>", "name": "..." }\`
- \`{ "_tag": "deleteSession", "sessionId": "<existing>" }\` — removes it and everything under it. Already-logged
  Sessions are copies and are untouched.
- \`{ "_tag": "orderSessions", "sessionIds": [...] }\` — the WHOLE ordered list; must name exactly the Plan's
  current Sessions, each once.
- \`{ "_tag": "addEntry", "sessionId": "<existing>", "blockId": "<existing or new>", "entryId": "<new id>",
  "exerciseId": "<exercise_catalog id>", "position": 2 }\` — naming an EXISTING blockId joins that Block (this is
  how a superset/circuit grows); naming a fresh one creates a straight Block to hold the Entry, placed at
  \`position\` among the Session's Blocks (appended when omitted). A new Entry has NO sets — follow it with a
  \`replaceEntrySets\` in the same array. \`exerciseId\` must resolve to a real catalog row: either one already in
  the \`exercise_catalog\` table, or one you declare in \`catalog_exercises\` (below). An id that resolves to
  neither is REJECTED, and the whole Proposal with it.
- \`{ "_tag": "removeEntry", "entryId": "<existing>" }\` — a Block left empty is removed with it; a grouped Block
  left holding one Entry collapses back to straight.
- \`{ "_tag": "orderEntries", "blockId": "<existing>", "entryIds": [...] }\` — one Block's WHOLE ordered Entry list.
- \`{ "_tag": "groupEntries", "sessionId": "<existing>", "blockId": "<new id>", "entryIds": [...],
  "format": "superset" | "circuit" | "emom" | "amrap" }\` — the Entries must be ADJACENT in that Session.
- \`{ "_tag": "ungroupBlock", "blockId": "<existing>" }\` — each Entry becomes its own straight Block, in place.
- \`{ "_tag": "moveEntryToBlock", "entryId": "<existing>", "blockId": "<existing>", "position": 0 }\`
- \`{ "_tag": "setBlockParams", "blockId": "<existing>", "format": "circuit", "params": { "rounds": 3 } }\`
- \`{ "_tag": "replaceEntrySets", "entryId": "<existing>", "sets": [ { "id": "<set id>", "setType": "working",
  "target": { "reps": { "min": 5, "max": 5 }, "load": { "min": 102.5, "max": 102.5 } }, "restSec": 120 } ] }\` —
  the Entry's ENTIRE ordered Set list. This is the workhorse: it is how you change a load, change a rep range,
  add a set, remove a set, change rest, or add a drop set. Carry FORWARD the Sets you are not changing, with
  their existing ids and targets, or they are gone. A set target is an interval per metric: equal bounds mean an
  exact target, differing bounds a range, one bound only means open-ended ("8+"), an empty object means "report
  it, no target". Only use the metrics that Entry actually tracks.
- \`{ "_tag": "setEntryExercise", "entryId": "<existing>", "exerciseId": "<exercise_catalog id>" }\` — points an
  Entry at a different exercise in place, keeping its id, position and Sets. Prefer it over removeEntry + addEntry
  when substituting one movement for another. The same catalog rule as \`addEntry\` applies to \`exerciseId\`.
- \`{ "_tag": "orderBlocks", "sessionId": "<existing>", "blockIds": [...] }\` — one Session's WHOLE ordered Block list.

Two rules run through all of it. **You supply the id of anything you create**, and **whole-value beats
positional** — every reorder and \`replaceEntrySets\` carries the entire list rather than an insert-at-index, so
there is no index drift to get wrong.

### Proposing an exercise the catalog does not have

The Exercise catalog is **not** a fixed library — it is jointly authored, and the coach may add to it (ADR
0016). But an \`exerciseId\` is a join key, so the row has to exist before an Entry can point at it, or the
Entry renders as a raw id, logs no metrics, and counts as zero volume toward every muscle forever.

So when a Proposal prescribes a movement the "Plan snapshot"/\`exercise_catalog\` does not already hold, declare
it alongside your operations, as a top-level \`catalog_exercises\` array ON THE SAME DECISION:

    "catalog_exercises": [
      { "exercise_id": "exercise-barbell-row", "name": "Barbell Row", "tracked_metrics": ["reps", "load"] }
    ]

- \`exercise_id\` is yours to mint, as \`exercise-<kebab-case-name>\`, and it is what your \`addEntry\` operations
  reference. **Check the catalog first** — reusing an id that already exists is always right, and minting a
  second id for a movement already in there splits the user's history across two rows that never rejoin.
- \`name\` is what the user reads on the card and in the logging grid.
- \`tracked_metrics\` is what logging renders for it (\`reps\`, \`load\`, \`duration\`, \`distance\`, \`rpe\`). Omit it only
  if you genuinely cannot say; the row is then created bare and picked up by a later review's enrichment.

This is NOT a Plan operation and does not go in \`plan_operations\`: creating an Exercise changes no Plan and
mints no Change. It is written when the user ACCEPTS, immediately before your operations are applied — so a
Proposal the user rejects creates nothing. Declare only the rows your own operations actually reference.

Emit \`plan_operations\` on a "proposal" decision ONLY, and only when you are proposing a change to the
prescription. Omit the field entirely when your finding changes nothing about the Plan — that is an ordinary
outcome, not a gap to fill. NEVER emit an operation as a placeholder or a gesture: the user taps Accept once
and it is applied verbatim, so an operation you are not sure about is worse than no Proposal at all.`;
