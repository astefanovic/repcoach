import { useCallback, useEffect, useState } from "react";

import { RPC_METHODS, type BodyweightEntry } from "@repcoach/contracts";

import { useRuntime } from "./RuntimeProvider.tsx";
import { callRpc, describeFailure } from "./rpc.ts";

/**
 * The bodyweight log (`bodyweight.*`), read once per mount and written
 * straight through — a connected write, not an outbox command, because the
 * Progress surface that hosts it is online-only and a weigh-in happens at
 * home, where the home server is. A write folds its result into the loaded
 * list, so the chart moves the moment the server says it took the reading.
 */
export type BodyweightState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly entries: ReadonlyArray<BodyweightEntry> }
  | { readonly status: "failed"; readonly reason: string };

export interface BodyweightHandle {
  readonly state: BodyweightState;
  /** Logs (or replaces) a day's reading, in kg. Rejects on failure. */
  readonly log: (date: string, weightKg: number) => Promise<void>;
  /** Removes a day's reading. Rejects on failure. */
  readonly remove: (date: string) => Promise<void>;
}

export function useBodyweight(enabled: boolean): BodyweightHandle {
  const runtime = useRuntime();
  const [state, setState] = useState<BodyweightState>({ status: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setState({ status: "loading" });
    void callRpc(runtime, RPC_METHODS.listBodyweight, {}).then(
      (result) => {
        if (!disposed) setState({ status: "ready", entries: result.entries });
      },
      (cause: unknown) => {
        if (!disposed) setState({ status: "failed", reason: describeFailure(cause) });
      },
    );
    return () => {
      disposed = true;
    };
  }, [runtime, enabled]);

  const log = useCallback(
    async (date: string, weightKg: number) => {
      const entry = await callRpc(runtime, RPC_METHODS.logBodyweight, { date, weightKg });
      setState((current) =>
        current.status !== "ready"
          ? current
          : {
              status: "ready",
              entries: [...current.entries.filter((e) => e.date !== entry.date), entry].sort((a, b) =>
                a.date.localeCompare(b.date),
              ),
            },
      );
    },
    [runtime],
  );

  const remove = useCallback(
    async (date: string) => {
      await callRpc(runtime, RPC_METHODS.removeBodyweight, { date });
      setState((current) =>
        current.status !== "ready"
          ? current
          : { status: "ready", entries: current.entries.filter((e) => e.date !== date) },
      );
    },
    [runtime],
  );

  return { state, log, remove };
}
