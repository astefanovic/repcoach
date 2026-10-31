import { useEffect, useRef, useState } from "react";

import { RPC_METHODS, type DecisionId, type DecisionWorking } from "@repcoach/contracts";

import { callRpc, describeFailure } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";

/**
 * The working behind one Decision (#79) — fetched on expand, not with the
 * feed.
 *
 * `decisions.get` is one-shot because everything it returns is frozen at
 * commit time (ADR 0011 §5). So this hook caches by id for the life of the
 * surface and never refetches: a second expand of the same item is free, and
 * there is no staleness to reconcile because there is no way for the row to
 * change underneath it.
 *
 * A failed fetch is **not** an error state for the item. The summary is
 * already on screen and is the part that matters; failing to load the working
 * means the expansion says so and offers nothing else, rather than replacing
 * a readable item with a red box.
 */
export type DecisionWorkingState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly working: DecisionWorking }
  | { readonly status: "failed"; readonly reason: string };

export function useDecisionWorking(
  decisionId: DecisionId | undefined,
  enabled: boolean,
): DecisionWorkingState {
  const runtime = useRuntime();
  const [state, setState] = useState<DecisionWorkingState>({ status: "idle" });
  // The id this hook has a request out for. It is what makes the fetch happen
  // once per id rather than once per render, and it is deliberately NOT paired
  // with a cleanup that cancels the in-flight promise: under StrictMode the
  // effect runs, tears down and runs again, and a cancel-on-cleanup would
  // abandon the only request while the ref made the second run skip firing a
  // replacement — a card stuck on "Loading the working…" forever. A late
  // response is instead discarded by checking the ref, which is the condition
  // that actually matters (the id moved on), not the effect's lifecycle.
  const requestedFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled || decisionId === undefined) return;
    if (requestedFor.current === decisionId) return;
    requestedFor.current = decisionId;
    setState({ status: "loading" });

    void callRpc(runtime, RPC_METHODS.getDecisionWorking, { decisionId } as never)
      .then((working) => {
        if (requestedFor.current !== decisionId) return;
        setState({ status: "ready", working: working as DecisionWorking });
      })
      .catch((cause: unknown) => {
        if (requestedFor.current !== decisionId) return;
        // Allow a retry on the next expand rather than caching the failure.
        requestedFor.current = undefined;
        setState({ status: "failed", reason: describeFailure(cause) });
      });
  }, [decisionId, enabled, runtime]);

  return decisionId === undefined ? { status: "idle" } : state;
}
