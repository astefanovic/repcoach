import { useEffect, useState } from "react";

import type { DailySetCount } from "@repcoach/contracts";

import { getDailySetCounts } from "./commands.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { describeFailure } from "./rpc.ts";

/**
 * Stats (issue #117), read once per mount — same one-shot shape as
 * `useSessionHistory` (its own doc explains why: no offline story of its
 * own, `enabled` gates the fetch on being connected rather than racing a
 * socket that is not there).
 */
export type DailySetCountsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly days: ReadonlyArray<DailySetCount> }
  | { readonly status: "failed"; readonly reason: string };

export function useDailySetCounts(enabled: boolean): DailySetCountsState {
  const runtime = useRuntime();
  const [state, setState] = useState<DailySetCountsState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setState({ status: "loading" });

    void getDailySetCounts(runtime).then(
      (result) => {
        if (!disposed) setState({ status: "ready", days: result.days });
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
