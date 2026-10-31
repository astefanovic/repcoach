import { useCallback, useEffect, useState } from "react";

import {
  RPC_METHODS,
  type AvailableModel,
  type CadenceModelSetting,
  type DeliberationCadence,
  type DeliberationEffort,
  type GetSpendSummaryResult,
  type RpeCaptureMode,
} from "@repcoach/contracts";

import { useRuntime, type RepCoachRuntime } from "./RuntimeProvider.tsx";
import { callRpc, describeFailure } from "./rpc.ts";
import { useRpcSessionEpoch } from "./useRpcSessionEpoch.ts";

/**
 * The Settings destination (#81) — the last of the four top-level surfaces
 * #42 settled, and the one the run ledger's spend section reads.
 *
 * Four cadences resolve a model at run time (`deliberationRunner.ts` L361,
 * L473, L811 — the fourth, `on-demand`, shares Session review's read since it
 * is the SAME runner pipeline under a different trigger, ADR 0011 §4), so all
 * four get a selector. `revision-run` is deliberately excluded — ADR 0013 §6
 * fixes it to read the Session-review model, so it is rendered as
 * non-configurable with the reason on screen rather than given a dead
 * control.
 */
export const CONFIGURABLE_CADENCES: ReadonlyArray<DeliberationCadence> = [
  "session-review",
  "cycle-review",
  "intake",
  "on-demand",
];

export type CadenceModelState = { readonly model: string | null; readonly effort: DeliberationEffort | null };

export type SettingsState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly models: ReadonlyMap<DeliberationCadence, CadenceModelState>;
      /**
       * The selectable models, read live from the Agent SDK on the home
       * server (issue #81 follow-up) rather than authored in this client.
       * Empty with a `catalogUnavailableReason` when the server could not
       * read it — the selector then degrades to its free-text field.
       */
      readonly catalog: ReadonlyArray<AvailableModel>;
      readonly catalogUnavailableReason: string | null;
      readonly rpeMode: RpeCaptureMode;
      readonly spend: GetSpendSummaryResult;
    }
  | { readonly status: "failed"; readonly reason: string };

export interface SettingsHandle {
  readonly state: SettingsState;
  /** Applies immediately — no save button (#81's "reads like the rest of the app"). */
  readonly setModel: (cadence: DeliberationCadence, model: string, effort: DeliberationEffort | undefined) => void;
  readonly setRpeMode: (mode: RpeCaptureMode) => void;
  /** Best-effort per-cadence save failure, cleared on the next successful save for that cadence. */
  readonly modelSaveErrors: ReadonlyMap<DeliberationCadence, string>;
  readonly rpeSaveError: string | undefined;
}

const loadAll = async (runtime: RepCoachRuntime): Promise<{
  readonly models: ReadonlyMap<DeliberationCadence, CadenceModelState>;
  readonly catalog: ReadonlyArray<AvailableModel>;
  readonly catalogUnavailableReason: string | null;
  readonly rpeMode: RpeCaptureMode;
  readonly spend: GetSpendSummaryResult;
}> => {
  const [modelEntries, catalog, rpe, spend] = await Promise.all([
    Promise.all(
      CONFIGURABLE_CADENCES.map(async (cadence) => {
        const result = await callRpc(runtime, RPC_METHODS.getCadenceModel, { cadence });
        return [cadence, { model: result.model, effort: result.effort }] as const;
      }),
    ),
    callRpc(runtime, RPC_METHODS.listModels, {}),
    callRpc(runtime, RPC_METHODS.getRpeCaptureMode, {}),
    callRpc(runtime, RPC_METHODS.getSpendSummary, {}),
  ]);
  return {
    models: new Map(modelEntries),
    catalog: catalog.models,
    catalogUnavailableReason: catalog.unavailableReason,
    rpeMode: rpe.mode,
    spend,
  };
};

export function useSettings(): SettingsHandle {
  const runtime = useRuntime();
  // Reload on every (re)connect: Settings is often the first page opened (it is
  // where `pnpm repcoach install` lands), so the first load can race the socket.
  const epoch = useRpcSessionEpoch(runtime);
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [modelSaveErrors, setModelSaveErrors] = useState<ReadonlyMap<DeliberationCadence, string>>(new Map());
  const [rpeSaveError, setRpeSaveError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    loadAll(runtime)
      .then((loaded) => {
        if (live) setState({ status: "ready", ...loaded });
      })
      .catch((cause: unknown) => {
        if (live) setState({ status: "failed", reason: describeFailure(cause) });
      });
    return () => {
      live = false;
    };
  }, [runtime, epoch]);

  const setModel = useCallback(
    (cadence: DeliberationCadence, model: string, effort: DeliberationEffort | undefined) => {
      setState((current) =>
        current.status === "ready"
          ? { ...current, models: new Map(current.models).set(cadence, { model, effort: effort ?? null }) }
          : current,
      );
      const payload: CadenceModelSetting = { cadence, model, ...(effort === undefined ? {} : { effort }) };
      void callRpc(runtime, RPC_METHODS.setCadenceModel, payload)
        .then(() => {
          setModelSaveErrors((current) => {
            if (!current.has(cadence)) return current;
            const next = new Map(current);
            next.delete(cadence);
            return next;
          });
        })
        .catch((cause: unknown) => {
          setModelSaveErrors((current) => new Map(current).set(cadence, describeFailure(cause)));
        });
    },
    [runtime],
  );

  const setRpeMode = useCallback(
    (mode: RpeCaptureMode) => {
      setState((current) => (current.status === "ready" ? { ...current, rpeMode: mode } : current));
      void callRpc(runtime, RPC_METHODS.setRpeCaptureMode, { mode })
        .then(() => setRpeSaveError(undefined))
        .catch((cause: unknown) => setRpeSaveError(describeFailure(cause)));
    },
    [runtime],
  );

  return { state, setModel, setRpeMode, modelSaveErrors, rpeSaveError };
}
