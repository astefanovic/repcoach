import { createHash } from "node:crypto";

import type { ImportedWorkout, LogSetActualResult, PrescribedSession } from "@repcoach/contracts";

/**
 * One imported workout (`workoutImport.ts`) as the rows both `Store` layers
 * write: a finished Logged Session's id and frozen snapshot, and one
 * `logSetActual` row per Set.
 *
 * Every id is derived from `importKey`, so a re-import addresses the same
 * rows and the layers can skip what already exists. The snapshot is the
 * workout as it was performed — one straight Block per exercise, an open
 * target for each metric it recorded — because there was no prescription; the actuals then line up
 * with it exactly, so history, the net-state view the coach reads and every
 * stat treat it like any other finished session.
 *
 * The source apps record no per-Set time, so each Set's `appliedAt` is the
 * workout's start plus one second per Set: it keeps the logged order, which
 * is all the net-state fold reads it for.
 */
export interface ImportedSessionRows {
  readonly loggedSessionId: string;
  readonly snapshot: PrescribedSession;
  readonly actuals: ReadonlyArray<LogSetActualResult>;
}

export const importedLoggedSessionId = (importKey: string): string =>
  `import-${createHash("sha256").update(importKey).digest("hex").slice(0, 32)}`;

export function importedSessionRows(workout: ImportedWorkout): ImportedSessionRows {
  const loggedSessionId = importedLoggedSessionId(workout.importKey);
  const start = Date.parse(workout.startedAt);
  const actuals: Array<LogSetActualResult> = [];
  let setIndex = 0;
  const snapshot: PrescribedSession = {
    id: loggedSessionId as never,
    ...(workout.name !== undefined ? { name: workout.name } : {}),
    blocks: workout.entries.map((entry, entryIndex) => {
      const entryId = `${loggedSessionId}-e${entryIndex}`;
      // Open intervals: "report", no prescribed number — the grid draws a
      // field per target key, so this is what makes the actuals visible.
      const openTarget = Object.fromEntries(entry.trackedMetrics.map((metric) => [metric, {}]));
      return {
        id: `${loggedSessionId}-b${entryIndex}` as never,
        format: "straight" as const,
        entries: [
          {
            id: entryId as never,
            exerciseId: entry.exerciseId,
            trackedMetrics: entry.trackedMetrics,
            sets: entry.sets.map((set, index) => {
              const setId = `${entryId}-s${index}`;
              actuals.push({
                commandId: `${loggedSessionId}:${setId}` as never,
                loggedSessionId: loggedSessionId as never,
                sessionId: loggedSessionId as never,
                entryId: entryId as never,
                setId: setId as never,
                setType: set.setType,
                actual: set.actual,
                appliedAt: new Date((Number.isFinite(start) ? start : 0) + setIndex++ * 1000).toISOString(),
                retraction: false,
              });
              return { id: setId as never, setType: set.setType, target: openTarget };
            }),
          },
        ],
      };
    }),
  };
  return { loggedSessionId, snapshot, actuals };
}
