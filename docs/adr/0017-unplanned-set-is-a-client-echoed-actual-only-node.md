# An unplanned Set is a client-echoed actual-only node, not a new contract

[ADR 0007](./0007-minimal-plan-is-degenerate-manual-plan.md) already names the shape: *"unplanned work is a node with an actual side and no prescribed [side]"*. This decides how that node is actually produced and rendered (#115 item 1 — "another straight set"), without re-litigating the shape.

## The load-bearing question, answered

Does an unplanned Set extend the Logged Session's frozen prescription copy, or live as an actual with no prescription behind it? **The latter — extending nothing.** No migration, no new RPC method, no new field on `PrescribedEntry`.

`logSetActual`'s contract (`LogSetActualInput`/`Result`) already carries `entryId`/`setId` **by value**, with no FK or lookup validation anywhere in the write path: `logged_set_actual.set_id`/`entry_id` are plain `TEXT`, and `applyNow` inserts and reads back by `command_id` alone, never checking the prescribed tree. The outbox's `QueuedSetActual` and the dev-server's passthrough handler are equally by-value. An unplanned Set was already representable; nothing needed widening.

## What "another straight set" actually mints

A client-minted `SetId` (`makeSetId`, same helper every other client-minted id uses) paired with a **target echoed from the Entry's last working Set** — same target metric map, same `restSec`, `setType: "working"`. `Logging.anotherStraightSet` (client-runtime, pure) computes this echo; nothing about it is persisted as a "prescription" anywhere — it is recomputed from the frozen `entry.sets` on every render, including after a reload, so no new storage is needed to keep it stable. The row then flows through the *exact same* `confirmSet` → outbox → `logSetActual` path a prescribed Set uses.

This is why no new RPC method exists: the row behaves like a prescribed Set with a ghost prescription right up until the client stops synthesizing it, at which point it is pure actual, same as every other row once logged.

## Rendering: extend the tree at the UI layer only

The Logging surface builds a per-render `PrescribedSession` that has each Entry's `sets` **extended** with (a) rows added this session via the sheet and (b) rows reconstructed after a reload from `model.actuals` whose `setId` has no matching prescribed Set for that Entry. Reconstruction re-runs `anotherStraightSet` against the same frozen `entry.sets`, so it is idempotent and requires no persisted linkage beyond what `logSetActual` already returns (`entryId`, used to bucket an orphan actual back to its Entry — the one field `useLoggedSession`'s merged model did not previously carry through, and now does).

Every other grid function — `deriveSetFields`, `groupSetsWithContinuations`, `setDeviations`, ghost-text, one-tap confirm — is unchanged and applies to a synthesized row exactly as it does to a real one. `EntrySection`/`SetRow` needed no changes beyond threading `entryId` alongside `setId` through `onRecord`, because from their point of view an unplanned Set already looks like a normal `PrescribedSet`.

## Considered and rejected

- **A new RPC method (`logging.logUnplannedSetActual`)** — rejected as pure duplication once the contract audit above showed `logSetActual` already accepts by-value ids. A parallel method would have needed the same idempotency and outbox wiring for no behavioral difference.
- **Persisting the echoed target** (a "shadow prescribed Set" row server-side) — rejected: it would resurrect exactly the extended-prescription-copy option this ADR declines, and buys nothing the client-side re-derivation doesn't already give for free, deterministically, from data already returned.
- **A distinct render component for unplanned rows** — rejected per the ticket's own constraint ("every one of these renders in the existing set-row grid with no new visual language"); the echoed-`PrescribedSet` approach makes that automatic rather than a rule to remember.

## Consequences

- `LoggedSetActual` (the client's merged actuals model) now carries `entryId` for every source (server, local, outbox) — previously dropped, needed to bucket orphan actuals back to an Entry.
- Continuations (drop/rest-pause/myo-cluster), swap, and note are explicitly **not** covered here; the sheet's other items keep their "not yet wired" hint. `Logging.anotherStraightSet`'s anchor-lookup (last non-continuation Set) is written to already tolerate continuation-tagged Sets appearing in the list, so wiring continuations later should not require revisiting this function.
- An unplanned Set added but not yet confirmed is client-only React state and does not survive a reload — consistent with how an unconfirmed prescribed Set already behaves (nothing is captured until ✓).
