import type { ActiveLoggedSessionSummary } from "@repcoach/contracts";

import type { InFlightSession } from "./inFlightSession.ts";

/**
 * Reconcile the device-local Resume pointer against the server's list of
 * `active` Logged Sessions (issue #147).
 *
 * The pointer (`repcoach.inFlightSession`) is only a synchronous first-render
 * hint. A browser that loses site data, or a second device, has no pointer —
 * and before `listActiveSessions` there was no way to ask the server, so a
 * genuinely open session became unreachable from every surface. This is the
 * pure decision that fixes it; the hook that owns the RPC and the side effects
 * is `useInFlightReconciliation`.
 *
 * Pure and total so it can be unit-tested without a runtime — the web package
 * has no hook-rendering test setup.
 */
export type InFlightReconcileAction =
  | { readonly kind: "keep" }
  | { readonly kind: "clear" }
  | { readonly kind: "adopt"; readonly session: InFlightSession };

export function reconcileInFlight(args: {
  readonly pointer: InFlightSession | undefined;
  readonly activeSessions: ReadonlyArray<ActiveLoggedSessionSummary>;
}): InFlightReconcileAction {
  const { pointer, activeSessions } = args;

  if (activeSessions.length === 0) {
    // A definitive server answer that nothing is in flight. A pointer that
    // still names a session is stale — finished or cancelled on another
    // device, or its row is gone — so clear it. A *failed* `finishWorkout`
    // does not reach this branch: it leaves the session genuinely `active`,
    // so the server would list it and the pointer would be kept below.
    return pointer === undefined ? { kind: "keep" } : { kind: "clear" };
  }

  if (
    pointer !== undefined &&
    activeSessions.some((session) => session.loggedSessionId === pointer.loggedSessionId)
  ) {
    // The pointer names a session the server still calls `active`. Leave it —
    // never yank the user off the workout they are in, even when a second
    // `active` row exists.
    return { kind: "keep" };
  }

  // No pointer, or one the server disagrees with, and the server has at least
  // one `active` session. Adopt the newest-started — "newest wins" for the
  // (pathological, but reachable) several-active-rows case.
  const newest = [...activeSessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]!;
  return {
    kind: "adopt",
    session: {
      loggedSessionId: newest.loggedSessionId,
      prescribedSessionId: newest.prescribedSessionId,
      startedAt: newest.startedAt,
    },
  };
}
