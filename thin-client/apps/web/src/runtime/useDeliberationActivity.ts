import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { Connection, Rpc } from "@repcoach/client-runtime";
import { RPC_METHODS, type RunStatus } from "@repcoach/contracts";

import { useRuntime } from "./RuntimeProvider.tsx";
import { useLandingFlash } from "./useLandingFlash.ts";

/**
 * The status strip's Deliberation-run states (issue #78) — the scheduled and
 * session-review run kind that `apps/expo`'s `DeliberationStateIndicator`
 * showed until #53 retired it. Not a port of that component: #42 settled that
 * ambient run status lives in the persistent strip, so this is a headless hook
 * feeding `statusStripState` rather than a second indicator.
 *
 * Rides the dedicated `deliberation.subscribeState` stream (unlike
 * `useRevisionActivity`, which piggybacks on the exchange channel) because
 * that stream *is* the contract's run-visibility surface — ADR 0011 §8's
 * honest deferral queue included, which is why `queuedCount` is carried
 * through rather than flattened to a boolean.
 */
export function useDeliberationActivity(): {
  readonly deliberationStatus: RunStatus;
  readonly deliberationQueuedCount: number;
  readonly deliberationJustLanded: boolean;
  /** Only present while `deliberationStatus === "failed"` (issue #90). */
  readonly deliberationFailureReason: string | undefined;
} {
  const runtime = useRuntime();
  const [status, setStatus] = useState<RunStatus>("idle");
  const [queuedCount, setQueuedCount] = useState(0);
  const [failureReason, setFailureReason] = useState<string | undefined>(undefined);
  const { justLanded, land } = useLandingFlash();

  useEffect(() => {
    // Only `running → idle` is a completion. `queued → idle` is a run that
    // never happened — cancelled, or dropped when the runner reset — and #42
    // spends green on work finishing, not on work disappearing. A run that
    // transitions to `"failed"` is likewise never a completion (issue #90) —
    // the flash is reserved for work that actually landed.
    let previous: RunStatus = "idle";

    const fiber = Effect.runFork(
      Rpc.subscribe(RPC_METHODS.subscribeDeliberationState, {}).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            const completed = previous === "running" && state.status === "idle";
            previous = state.status;

            if (completed) land();

            setStatus(state.status);
            setQueuedCount(state.queuedCount);
            setFailureReason(state.failureReason);
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

  return {
    deliberationStatus: status,
    deliberationQueuedCount: queuedCount,
    deliberationJustLanded: justLanded,
    deliberationFailureReason: failureReason,
  };
}
