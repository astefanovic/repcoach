import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, type PlanSnapshot } from "@repcoach/contracts";

import { loadCachedPlan, saveCachedPlan } from "../platform/planSnapshotStorage.ts";
import { describeFailure } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";

/**
 * The Plan, live (#72 user stories 1 and 2).
 *
 * `subscribePlan` re-attaches and replays the current snapshot on every
 * reconnect, so this is a subscription rather than a fetch: an accepted
 * Proposal or an edit made from another device lands without the user
 * pulling to refresh, and a reconnect after the gym's dead spot resyncs by
 * itself.
 *
 * **Offline is the interesting half.** Every snapshot that arrives is
 * written to IndexedDB, and the hook starts by reading that cache. So an
 * offline launch renders the Plan the user last saw — marked `stale`, which
 * is what Today's picker uses to avoid promising a "Start" it cannot honour
 * — instead of the blank screen story 2 exists to eliminate.
 */
export type PlanState =
  /** No Plan on screen yet, and no cached one to fall back to. */
  | { readonly status: "loading" }
  /** From IndexedDB, not from the server this session. */
  | { readonly status: "stale"; readonly plan: PlanSnapshot }
  | { readonly status: "live"; readonly plan: PlanSnapshot }
  | { readonly status: "failed"; readonly reason: string };

/**
 * "No Plan yet" is a Plan with no Sessions, not a missing Plan — the server
 * always has a Plan row. Today's Intake invitation keys off this.
 */
export function isEmptyPlan(plan: PlanSnapshot): boolean {
  return plan.sessions.length === 0;
}

/** The Plan snapshot behind any state that has one. */
export function planOf(state: PlanState): PlanSnapshot | undefined {
  return state.status === "live" || state.status === "stale" ? state.plan : undefined;
}

export function usePlan(): PlanState {
  const runtime = useRuntime();
  const [state, setState] = useState<PlanState>({ status: "loading" });

  useEffect(() => {
    let disposed = false;

    // The cache read races the first server snapshot on purpose, and loses
    // gracefully: it only ever downgrades `loading`, so a fast connection
    // never flashes a stale Plan over the live one.
    void loadCachedPlan().then((cached) => {
      if (disposed || cached === undefined) return;
      setState((current) => (current.status === "loading" ? { status: "stale", plan: cached } : current));
    });

    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribePlan, {}).pipe(
        Stream.runForEach((plan) =>
          Effect.sync(() => {
            if (disposed) return;
            setState({ status: "live", plan });
            void saveCachedPlan(plan);
          }),
        ),
        Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor),
        // A feed failure must not blank a Plan already on screen: the last
        // snapshot stays, downgraded to stale. Only a client with nothing to
        // show reports the failure, because only there is it the whole story
        // (story 38 — an honest error state rather than an empty surface).
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (disposed) return;
            setState((current) =>
              current.status === "live"
                ? { status: "stale", plan: current.plan }
                : current.status === "stale"
                  ? current
                  : { status: "failed", reason: describeFailure(cause) },
            );
          }),
        ),
      ),
    );

    return () => {
      disposed = true;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime]);

  return state;
}
