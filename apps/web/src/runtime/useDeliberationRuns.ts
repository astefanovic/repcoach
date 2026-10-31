import { useEffect, useMemo, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, type DeliberationRunRecord } from "@repcoach/contracts";

import { describeFailure } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";

/**
 * The Coach record's run history (ADR 0011 §8) — every Deliberation run, with
 * what came out of it.
 *
 * Same idiom as `useCoachingFeed`, and deliberately so: one `Rpc.subscribe`
 * fiber, accumulated by id, interrupted on unmount, with reconnection left to
 * the supervisor's `switchMap` over the session. What differs is what a
 * re-emission means. The feed's entries are immutable once written, so a
 * repeat is a replay; a **run** genuinely changes — it opens `running` and
 * closes `committed` or `failed` — so accumulating by `runId` is not just
 * de-duplication, it is how the live node at the top of the rail moves without
 * the list being rebuilt underneath the user.
 *
 * **Newest-first**, like the feed and for the same reason, with one extra
 * consequence: it is what puts the run happening right now at the top. That is
 * the prototype's whole claim about this surface — watching the coach work and
 * reading what it did afterwards are one list, not a banner above a log.
 *
 * A failure does not blank a history already on screen (`usePlan`'s "last good
 * state over a failed one" call). It is reported through `staleReason` so the
 * surface can say the record may be behind rather than throw away what it has.
 */
export type DeliberationRunsState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly runs: ReadonlyArray<DeliberationRunRecord>;
      /** Set when the stream has failed since the runs below were received. */
      readonly staleReason: string | undefined;
    }
  | { readonly status: "failed"; readonly reason: string };

export function useDeliberationRuns(): DeliberationRunsState {
  const runtime = useRuntime();
  const [runs, setRuns] = useState<ReadonlyMap<string, DeliberationRunRecord> | undefined>(
    undefined,
  );
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribeDeliberationRuns, {}).pipe(
        Stream.runForEach((run) =>
          Effect.sync(() => {
            setFailure(undefined);
            setRuns((current) => new Map(current ?? []).set(run.runId, run));
          }),
        ),
        Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor),
        Effect.catchCause((cause) => Effect.sync(() => setFailure(describeFailure(cause)))),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime]);

  const ordered = useMemo(
    () =>
      runs === undefined
        ? []
        : [...runs.values()].sort(
            (a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId),
          ),
    [runs],
  );

  if (runs === undefined) {
    return failure === undefined ? { status: "loading" } : { status: "failed", reason: failure };
  }
  return { status: "ready", runs: ordered, staleReason: failure };
}
