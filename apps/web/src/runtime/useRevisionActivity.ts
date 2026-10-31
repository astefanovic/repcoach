import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, type ProposalRevisionStatus } from "@repcoach/contracts";

import { useRuntime } from "./RuntimeProvider.tsx";
import { useLandingFlash } from "./useLandingFlash.ts";

/**
 * The status strip's two Revision-run states (ADR 0013 §5, issue #66 slice
 * 3): "coach running" while a run is queued/running against any Proposal, and
 * a ~3s green flash the moment one lands. `statusStrip.ts` stays pure, so the
 * flash's timer lives here, on the one hook that watches the stream.
 *
 * Rides `subscribeProposalExchanges` rather than a dedicated subscription —
 * same reasoning `rpc.ts`'s doc on that RPC gives for the card itself: the
 * live revisionStatus is already carried on this channel, and a second
 * subscription just for the strip's badge could race it.
 *
 * The flash window itself is `useLandingFlash` (#78), shared with the
 * Deliberation watcher so the two run kinds cannot drift to different
 * durations.
 */
export function useRevisionActivity(): {
  readonly revisionRunning: boolean;
  readonly revisionJustLanded: boolean;
} {
  const runtime = useRuntime();
  const [running, setRunning] = useState(false);
  const { justLanded, land } = useLandingFlash();

  useEffect(() => {
    const byId = new Map<string, ProposalRevisionStatus>();

    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribeProposalExchanges, {}).pipe(
        Stream.runForEach((exchange) =>
          Effect.sync(() => {
            const previous = byId.get(exchange.proposalId);
            byId.set(exchange.proposalId, exchange.revisionStatus);

            const wasInFlight = previous === "queued" || previous === "running";
            const nowIdle = exchange.revisionStatus === "idle";
            if (wasInFlight && nowIdle) land();

            setRunning([...byId.values()].some((status) => status !== "idle"));
          }),
        ),
        Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor),
        Effect.catchCause(() => Effect.void),
      ),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime, land]);

  return { revisionRunning: running, revisionJustLanded: justLanded };
}
