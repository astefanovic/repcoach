import { useCallback, useEffect, useState } from "react";

import { RPC_METHODS, type CatalogExercise, type ExerciseId } from "@repcoach/contracts";

import { makeExerciseId } from "./ids.ts";
import { useRuntime } from "./RuntimeProvider.tsx";
import { callRpc, describeFailure } from "./rpc.ts";
import { useRpcSessionEpoch } from "./useRpcSessionEpoch.ts";

/**
 * The Exercise catalog (#72 user story 29), read once per mount of whatever
 * opens the picker — and, since #102, written from the same place.
 *
 * Not cached durably, unlike the Plan. Adding an exercise is a connected
 * action anyway — `applyUserPlanChange` is a round-trip — so a catalog the
 * client could show while offline would only let the user pick something it
 * then could not add. ADR 0016 takes the same line one step further for
 * creating: it is a *second* connected write, so the affordance is disabled
 * offline rather than queued.
 */
export type ExerciseCatalogState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly exercises: ReadonlyArray<CatalogExercise> }
  | { readonly status: "failed"; readonly reason: string };

export interface ExerciseCatalogHandle {
  readonly state: ExerciseCatalogState;
  /**
   * Mints a **User-authored exercise** (ADR 0016) and folds it into the
   * loaded catalog, so the picker that created it lists it immediately and
   * every later open gets it from the server.
   *
   * The id is minted **here**, not by the server: this write sits outside the
   * outbox and therefore outside its `commandId` dedupe, so the client's id
   * is the only thing that keeps a retry from minting two exercises.
   *
   * Rejects on failure, like every other `callRpc` caller — the catalog row
   * has to exist before `addEntry` can name it, so the caller must be able to
   * stop.
   *
   * `libraryId` links the row to the Exercise library entry it was picked
   * from, so it carries that entry's animation; omitted for a typed name.
   */
  readonly create: (name: string, libraryId?: string) => Promise<CatalogExercise>;
  /** Renames a row in place, keeping its id (ADR 0016 — rename is what makes silent enrichment safe). */
  readonly rename: (exerciseId: ExerciseId, name: string) => Promise<CatalogExercise>;
}

export function useExerciseCatalog(enabled: boolean): ExerciseCatalogHandle {
  const runtime = useRuntime();
  const [state, setState] = useState<ExerciseCatalogState>({ status: "loading" });
  const sessionEpoch = useRpcSessionEpoch(runtime);
  /** Bumped by a write that landed while no list was loaded — the server just answered, so read again. */
  const [reread, setReread] = useState(0);
  const loaded = state.status === "ready";

  /**
   * Read on mount, and again each time the RPC session comes up until a read
   * lands. Logging opens the catalog with `enabled` always true, so after the
   * phone reloads a discarded tab the first read beats the socket and fails
   * with "not connected". Without the retry that failure stuck for the whole
   * workout: every name fell back to its de-slugged id (a UUID for anything
   * picked from the library), and `absorb` had no ready list to fold a new
   * row into, so a swap target showed as an id and the picker could not see
   * the row it had just created.
   */
  useEffect(() => {
    if (!enabled || loaded) return;
    let disposed = false;

    void callRpc(runtime, RPC_METHODS.getExerciseCatalog, {}).then(
      (catalog) => {
        if (!disposed) setState({ status: "ready", exercises: catalog.exercises });
      },
      (cause: unknown) => {
        if (!disposed) {
          setState({ status: "failed", reason: describeFailure(cause) });
        }
      },
    );

    return () => {
      disposed = true;
    };
  }, [runtime, enabled, loaded, sessionEpoch, reread]);

  /**
   * Folds one server-confirmed row into the loaded catalog — insert or
   * replace, keyed by id, which covers both writes: a create appends, a
   * rename overwrites in place. The server's row is what lands, never a
   * locally-guessed one, so what the picker shows is what `addEntry` will be
   * validated against. With no list loaded there is nothing to fold into,
   * so it asks for a fresh read instead, which carries the new row.
   */
  const absorb = useCallback((exercise: CatalogExercise) => {
    // A no-op for the read effect once a list is loaded; it only re-reads while none is.
    setReread((n) => n + 1);
    setState((current) => {
      if (current.status !== "ready") return current;
      const without = current.exercises.filter((existing) => existing.id !== exercise.id);
      return { status: "ready", exercises: [...without, exercise] };
    });
  }, []);

  const create = useCallback(
    async (name: string, libraryId?: string) => {
      const exercise = await callRpc(runtime, RPC_METHODS.createExercise, {
        exerciseId: makeExerciseId(),
        name,
        ...(libraryId === undefined ? {} : { libraryId }),
      });
      absorb(exercise);
      return exercise;
    },
    [runtime, absorb],
  );

  const rename = useCallback(
    async (exerciseId: ExerciseId, name: string) => {
      const exercise = await callRpc(runtime, RPC_METHODS.renameExercise, { exerciseId, name });
      absorb(exercise);
      return exercise;
    },
    [runtime, absorb],
  );

  return { state, create, rename };
}
