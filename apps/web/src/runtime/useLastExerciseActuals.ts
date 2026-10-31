import { useEffect, useState } from "react";

import { Logging } from "@repcoach/client-runtime";
import { RPC_METHODS, type ExerciseId, type MetricName } from "@repcoach/contracts";

import { callRpc } from "./rpc.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { useRpcSessionEpoch } from "./useRpcSessionEpoch.ts";

/** The last time an Exercise was performed, as the Logging rows read it. */
export interface LastExerciseUse {
  /**
   * Tier 2 of the one-tap ✓ seed (issue #149): the most recent actual per
   * metric. `undefined` when there is none, never an empty `Map`.
   */
  readonly perMetric: ReadonlyMap<MetricName, number> | undefined;
  /** That last session Set by Set (UAT) — what each row suggests. Empty when never performed. */
  readonly sets: ReadonlyArray<Logging.LastTimeSet>;
  /** The best e1RM ever reached on this Exercise — the bar a Set must clear to be marked a PR. */
  readonly bestE1rm: number | undefined;
}

/**
 * What the user did the last time `exerciseId` was **performed**, across
 * finished Logged Sessions (`logging.lastActualForExercise`, swap-aware
 * server read): per metric for the #149 seed, and Set by Set for the row
 * suggestions.
 *
 * **Online-only, by design.** Tier 1 (`Grid.seedFromPreviousSet`, an earlier
 * Set of this Entry) is a pure derivation over Sets already on screen and
 * works offline; this is a cross-session read with no local source. While
 * the fetch cannot succeed — offline, dead socket, a slow server — this is
 * `undefined` and the rows fall back to the plan's range (or render `–`).
 * An honest absence, never a hang: nothing on the Logging surface waits on
 * it. See ADR 0021 and uat-watchlist #14.
 *
 * A failed fetch is retried when the RPC session next comes up. The read is
 * made on mount, and after a reload the surface mounts before the socket has
 * connected, so without the retry the history never arrived at all.
 */
export function useLastExerciseActuals(exerciseId: ExerciseId | undefined): LastExerciseUse | undefined {
  const runtime = useRuntime();
  const sessionEpoch = useRpcSessionEpoch(runtime);
  const [loaded, setLoaded] = useState<
    { readonly exerciseId: ExerciseId; readonly use: LastExerciseUse } | undefined
  >(undefined);
  const current = loaded !== undefined && loaded.exerciseId === exerciseId ? loaded.use : undefined;
  const have = current !== undefined;

  useEffect(() => {
    if (exerciseId === undefined || have) return;
    let disposed = false;

    void (async () => {
      try {
        const result = await callRpc(runtime, RPC_METHODS.lastActualForExercise, { exerciseId });
        if (disposed) return;
        const entries = (Object.entries(result.perMetric) as ReadonlyArray<[MetricName, number]>).filter(
          ([, value]) => value !== undefined,
        );
        setLoaded({
          exerciseId,
          use: {
            perMetric: entries.length > 0 ? new Map(entries) : undefined,
            sets: result.sets,
            bestE1rm: result.bestE1rm,
          },
        });
      } catch {
        // Offline / unreachable — the next connect retries; tier 1 and the
        // plan's range cover the rows until then.
      }
    })();

    return () => {
      disposed = true;
    };
  }, [runtime, exerciseId, have, sessionEpoch]);

  return current;
}
