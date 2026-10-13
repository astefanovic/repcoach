# A workout in flight is a server fact; the pointer is only a hint

Issue #147. Whether a workout is in progress was recorded in exactly one place: a
device-local `localStorage` key, `repcoach.inFlightSession`. The file's own doc
justified `localStorage` over IndexedDB because the value "can be re-derived by
the user tapping Start again" — and that sentence was the bug. Tapping Start
again does not re-derive the pointer; it mints a second `active` Logged Session.

## What went wrong

Lose the pointer — "clear on close", a private window, a second device, an
insecure-origin eviction (the production server usually serves plain http, so the
app is a bare tab with no service worker and more-evictable site data) — and for
a session the server still holds `active`:

1. Today shows the picker, not Resume. The session is unreachable from every
   surface: History excludes `active` at the SQL level (#114), and there was no
   RPC that answered "which Logged Sessions are `active`".
2. Starting the same Prescribed Session again leaves **two** `active` rows.
3. Neither is ever `finished`, so neither is ever marked `pending` review — the
   coach never sees the work. The same class of silent loss [ADR 0018](./0018-a-session-review-is-owed-by-a-row-not-by-a-request.md)
   fixed for a different cause.
4. Anything already logged into the orphan is invisible to the user forever.

## The decision

**The server is the source of truth for "is a workout in flight". The pointer
stays, as a synchronous first-render hint and nothing more.**

- A new read RPC, `logging.listActiveSessions` — the `active` rows, newest
  `startedAt` first, each with its **net** still-logged Set count (a mis-tapped
  log-then-retract does not inflate it). The mirror image of `listSessions`,
  which excludes `active`. No error channel: an empty list is a valid answer.
- Today reconciles the pointer against that list **once connected**
  (`useInFlightReconciliation`, `reconcileInFlight`): adopt an `active` session
  the pointer lost, clear a pointer the server no longer calls `active`, keep a
  pointer that still matches. Several `active` rows → newest-started wins.
- While **disconnected**, reconciliation is a no-op. The pointer plus the
  prescription cache and the outbox is a complete offline surface ([ADR 0009](./0009-thin-client-experiment-parallel-track.md)
  gate 3), and that must keep working with no server in reach.

**Why the pointer survives.** It is not redundant. Today has to choose
Resume-vs-picker on its *first* render, before any RPC has resolved, or it
flashes one and then the other. That is the whole reason the file gives for
`localStorage` over IndexedDB, and it still holds. What changed is that the
pointer is no longer the *only* record — it is now a cache of one the server
owns, reconciled on every connect.

**Why the failed-`finishWorkout` rule still holds.** `inFlightSession`'s doc
keeps the pointer through a *failed* `finishWorkout`, because the session really
is still open in that case. Reconciliation does not break this: a failed
finalization leaves the row genuinely `active`, so `listActiveSessions` returns
it and the pointer is kept.

## One intended workout, one active row — enforced in the client command

`startSession` in the store is **left non-idempotent**. Every call is a fresh
copy of the current Plan (ADR 0006/0007), and ~50 rung-1 tests lean on two
`startSession` calls yielding two distinct rows. Making the store dedupe by
`(prescribed_session_id, status='active')` would be a large, fragile change to a
well-covered contract for a guard that belongs closer to the user's intent
anyway.

Instead, the client's `startWorkout` command asks `listActiveSessions` first and
**adopts** an existing `active` session for the same Prescribed Session rather
than minting a duplicate. Combined with the reconcile on Today (which shows
Resume, so the user taps Resume not Start), the realistic duplicate path — same
device, lost pointer, tap Start — is closed. A dead link at that moment falls
back to pre-#147 behaviour, and the next connect's reconcile catches the
duplicate.

## Consequences

- **A pointer that disagrees with the server is resolved toward the server.** A
  pointer naming a `finished`/`cancelled`/gone session is cleared or replaced by
  a real `active` one; the user is never left tapping a Resume that goes nowhere.
- **Reconciliation is Today-scoped.** It runs in `TodaySurface`, which is where
  Resume-vs-picker is decided. `useInFlightSession` was refactored onto a shared
  `useSyncExternalStore` snapshot so its several consumers (the hero, the Logging
  surface's finish/cancel, the reconcile hook) agree within one document —
  per-hook `useState` only ever synced cross-*tab*.
- **Two devices racing Start in the same second can still make two `active`
  rows.** The client guard is not a distributed lock. Accepted as
  vanishingly-rare at personal scale — uat-watchlist entry 13.
- **`listActiveSessions` has no `/__test__` lever.** The e2e flow
  (`resume-after-site-data-loss.spec.ts`) exercises it through the UI:
  `localStorage.clear()` + reload, then assert Resume returns and the logged set
  is intact.
- **The drain / review path is untouched.** This ADR is about *reachability* of
  an in-flight session, not about what happens when it finishes — that is ADR
  0018's territory and it still holds.
