import { useEffect, useState } from "react";

import { RPC_METHODS, type ExerciseProgress } from "@repcoach/contracts";

import { useRuntime } from "./RuntimeProvider.tsx";
import { callRpc, describeFailure } from "./rpc.ts";

/**
 * The Progress surface's history read (`stats.getExerciseProgress`), once per
 * mount — the same one-shot, online-only shape as `useDailySetCounts`, for
 * the same reason: it is a server-side aggregate with no offline story of
 * its own, and `enabled` gates the fetch on being connected.
 */
export type ExerciseProgressState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly exercises: ReadonlyArray<ExerciseProgress> }
  | { readonly status: "failed"; readonly reason: string };

export function useExerciseProgress(enabled: boolean): ExerciseProgressState {
  const runtime = useRuntime();
  const [state, setState] = useState<ExerciseProgressState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setState({ status: "loading" });
    void callRpc(runtime, RPC_METHODS.getExerciseProgress, {}).then(
      (result) => {
        if (!disposed) setState({ status: "ready", exercises: result.exercises });
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
