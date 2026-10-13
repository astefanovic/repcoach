import { useEffect, useState } from "react";

import type { LoggedSessionSummary } from "@repcoach/contracts";

import { listSessions } from "./commands.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { describeFailure } from "./rpc.ts";

/**
 * History (issue #114 Part 2), read once per mount — same one-shot shape as
 * `useExerciseCatalog`. Not cached durably like the Plan (ADR 0009): History
 * has no offline story of its own (`Logging.tsx`'s "editing a past session"
 * strip already covers the reopened-session view; this is only the list),
 * so `enabled` gates the fetch on being connected rather than racing one
 * against a socket that is not there.
 */
export type SessionHistoryState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly sessions: ReadonlyArray<LoggedSessionSummary> }
  | { readonly status: "failed"; readonly reason: string };

export function useSessionHistory(enabled: boolean): SessionHistoryState {
  const runtime = useRuntime();
  const [state, setState] = useState<SessionHistoryState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setState({ status: "loading" });

    void listSessions(runtime).then(
      (result) => {
        if (!disposed) setState({ status: "ready", sessions: result.sessions });
      },
      (cause: unknown) => {
        if (!disposed) setState({ status: "failed", reason: describeFailure(cause) });
      },
    );

    return () => {
      disposed = true;
    };
  }, [runtime, enabled]);

  return state;
}
