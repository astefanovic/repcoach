import { useEffect, useMemo, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, type CoachingFeedEntry } from "@repcoach/contracts";

import { describeFailure } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";

/**
 * The Coaching feed (#79) — the permanent record the Coach surface renders.
 *
 * Same idiom as `useProposalCard`: one `Rpc.subscribe` fiber, accumulated by
 * id, interrupted on unmount. The subscription is subscribe-and-replay, so a
 * transport blip re-populates the feed with no reconnect handling here — the
 * supervisor's `switchMap` over the session does that work.
 *
 * **Newest-first**, which is the opposite of the store's order. The store
 * emits oldest-first because that is the order the log was written in; a
 * record the user opens to see what the coach has been saying wants the most
 * recent thing at the top.
 *
 * A failure does not blank a feed already on screen — the same "last good
 * state over a failed one" call `usePlan` makes. It is reported instead by
 * `staleReason`, so the surface can say the record may be behind without
 * throwing away what it has.
 */
export type CoachingFeedState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly entries: ReadonlyArray<CoachingFeedEntry>;
      /** Set when the stream has failed since the entries below were received. */
      readonly staleReason: string | undefined;
    }
  | { readonly status: "failed"; readonly reason: string };

export function useCoachingFeed(): CoachingFeedState {
  const runtime = useRuntime();
  const [entries, setEntries] = useState<ReadonlyMap<string, CoachingFeedEntry> | undefined>(
    undefined,
  );
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribeCoachingFeed, {}).pipe(
        Stream.runForEach((entry) =>
          Effect.sync(() => {
            setFailure(undefined);
            setEntries((current) => new Map(current ?? []).set(entry.id, entry));
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
      entries === undefined
        ? []
        : [...entries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [entries],
  );

  if (entries === undefined) {
    return failure === undefined ? { status: "loading" } : { status: "failed", reason: failure };
  }
  return { status: "ready", entries: ordered, staleReason: failure };
}
