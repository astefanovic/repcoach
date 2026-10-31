import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS } from "@repcoach/contracts";

import { useRuntime } from "./RuntimeProvider.tsx";

/**
 * How many decisions are owed (#72 user story 36: a count on Coach, so the
 * user knows decisions are waiting "without being nagged about
 * observations").
 *
 * That parenthesis is the whole specification of what to count. Only
 * `pending` Proposals qualify: an Observation is the coach noting something,
 * not asking for anything, and counting it would make the badge a
 * notification rather than a to-do.
 *
 * `subscribeProposals` replays current state on every reconnect, so the count
 * self-corrects after a dead spot without a refresh. A failed subscription
 * leaves the count at its last value rather than clearing it — the chrome
 * badge is not the place to report a broken feed, and dropping to zero would
 * quietly tell the user there is nothing to decide.
 */
export function usePendingProposalCount(): number {
  const runtime = useRuntime();
  const [count, setCount] = useState(0);

  useEffect(() => {
    // The stream emits one Proposal at a time and replays the full set on
    // (re)attach, so the count is accumulated by id rather than by tallying
    // emissions — a replay would otherwise double it.
    const byId = new Map<string, boolean>();

    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribeProposals, {}).pipe(
        Stream.runForEach((proposal) =>
          Effect.sync(() => {
            byId.set(proposal.id, proposal.status === "pending");
            setCount([...byId.values()].filter(Boolean).length);
          }),
        ),
        Effect.provideService(Connection.EnvironmentSupervisor, runtime.supervisor),
        Effect.catchCause(() => Effect.void),
      ),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime]);

  return count;
}
