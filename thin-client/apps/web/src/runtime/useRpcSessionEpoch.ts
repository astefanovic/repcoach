import { useEffect, useState } from "react";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { RepCoachRuntime } from "./RuntimeProvider.tsx";

/**
 * Counts the times the RPC session has come up: 0 until the first connect,
 * then one more on every reconnect.
 *
 * A one-shot read made on mount can land before the socket exists. The
 * runtime is "ready" as soon as the supervisor is built, not once it has
 * connected, so a page the phone reloads behind the user's back (a
 * backgrounded tab it discarded) mounts its surface into a session that is
 * still `None`, and `callRpc` fails at once with "not connected". A read
 * that depends on this number is retried when there is finally something to
 * read from, instead of keeping whatever it fell back to.
 */
export function useRpcSessionEpoch(runtime: RepCoachRuntime): number {
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    const fiber = Effect.runFork(
      SubscriptionRef.changes(runtime.supervisor.session).pipe(
        Stream.map(Option.isSome),
        Stream.changes,
        Stream.filter((connected) => connected),
        Stream.runForEach(() => Effect.sync(() => setEpoch((current) => current + 1))),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime]);

  return epoch;
}
