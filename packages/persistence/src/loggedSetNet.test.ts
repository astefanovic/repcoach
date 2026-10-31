import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { foldNetActuals, type LogSetActualInput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Migrations `023`/`024` — the `logged_set_net` view the coach counts Sets from.
 *
 * The bug it fixes lived in the coach's raw `sqlite3` reads, not in the app:
 * corrections are appended as new `logged_set_actual` rows, and a Proposal
 * counted those rows as Sets. So these tests write through the real
 * `SqlStore` (the same append path the phone uses), then read the view the
 * way the coach does — raw SQL over the file — and hold it to
 * `foldNetActuals`, the definition the app's own screens use.
 */

/** `node:sqlite` via `createRequire` — Vite cannot resolve the bare specifier. */
const nodeSqlite = createRequire(import.meta.url)("node:sqlite") as typeof NodeSqlite;

const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-logged-set-net-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

type Op =
  | { readonly kind: "log"; readonly setId: string; readonly load: number; readonly setType?: string }
  | { readonly kind: "unlog"; readonly setId: string }
  | { readonly kind: "swap"; readonly exerciseId: string };

/** Plays `ops` into a fresh Logged Session; returns its id. */
const playSession = (ops: ReadonlyArray<Op>, tag: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
    let seq = 0;
    for (const op of ops) {
      seq += 1;
      const commandId = `${tag}-${op.kind === "swap" ? op.exerciseId : op.setId}-${op.kind}-${seq}`;
      if (op.kind === "swap") {
        yield* store.swapEntryExercise({
          commandId,
          loggedSessionId,
          entryId: "entry-1",
          exerciseId: op.exerciseId,
        } as never);
      } else if (op.kind === "log") {
        yield* store.logSetActual({
          commandId,
          loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: op.setId,
          setType: op.setType ?? "working",
          actual: { reps: 10, load: op.load },
        } as unknown as LogSetActualInput);
      } else {
        yield* store.unlogSetActual({ commandId, loggedSessionId, entryId: "entry-1", setId: op.setId } as never);
      }
      // Distinct `applied_at`s, so the order under test is the write order.
      yield* Effect.sleep(3);
    }
    return loggedSessionId as string;
  });

/** What `foldNetActuals` says each Set's final load is. */
const foldLoads = (ops: ReadonlyArray<Op>): Record<string, number> => {
  const net = foldNetActuals(
    ops.flatMap((op) => (op.kind === "swap" ? [] : [op])).map((op) => ({
      setId: op.setId as never,
      retraction: op.kind === "unlog",
      load: op.kind === "log" ? op.load : undefined,
    })),
  );
  return Object.fromEntries([...net].map(([setId, row]) => [setId, row.load as number]));
};

const readView = (dbPath: string, loggedSessionId: string): Record<string, number> => {
  const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT set_id, actual_json FROM logged_set_net WHERE logged_session_id = ?")
      .all(loggedSessionId) as unknown as ReadonlyArray<{ set_id: string; actual_json: string }>;
    return Object.fromEntries(rows.map((r) => [r.set_id, (JSON.parse(r.actual_json) as { load: number }).load]));
  } finally {
    db.close();
  }
};

describe("logged_set_net view (migrations 023, 024)", () => {
  it("shows three corrected Sets as three Sets with their final loads, matching foldNetActuals", async () => {
    // The shape that misled the coach: 3 Sets, 7 rows, a typo'd load fixed
    // seconds later, plus a Set logged then un-logged.
    const ops: ReadonlyArray<Op> = [
      { kind: "log", setId: "s1", load: 140 },
      { kind: "log", setId: "s1", load: 120 },
      { kind: "log", setId: "s2", load: 168 },
      { kind: "log", setId: "s2", load: 160 },
      { kind: "log", setId: "s3", load: 120 },
      { kind: "log", setId: "s4", load: 120 },
      { kind: "unlog", setId: "s4" },
    ];
    const dbPath = tempDbPath();
    try {
      const id = await playSession(ops, "a").pipe(
        Effect.provide(SqlStore.layer({ filename: dbPath })),
        Effect.scoped,
        Effect.runPromise,
      );
      expect(readView(dbPath, id)).toEqual({ s1: 120, s2: 160, s3: 120 });
      expect(readView(dbPath, id)).toEqual(foldLoads(ops));
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("keeps the same set_id apart across sessions — Set ids are copied from the Plan and recur", async () => {
    const dbPath = tempDbPath();
    try {
      const [first, second] = await Effect.all([
        playSession(
          [
            { kind: "log", setId: "s1", load: 100 },
            { kind: "log", setId: "s1", load: 105 },
          ],
          "first",
        ),
        playSession([{ kind: "log", setId: "s1", load: 110 }], "second"),
      ]).pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);
      expect(readView(dbPath, first)).toEqual({ s1: 105 });
      expect(readView(dbPath, second)).toEqual({ s1: 110 });
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("counts a working Set and its drop sets as one Set, and names the swapped-to exercise", async () => {
    // The Oct 3 Pull day: incline DB curl prescribed, swapped twice before
    // the first Set, three working Sets, the last followed by two drops.
    const ops: ReadonlyArray<Op> = [
      { kind: "swap", exerciseId: "exercise-cable-curl" },
      { kind: "swap", exerciseId: "exercise-cable-one-arm-curl" },
      { kind: "log", setId: "s1", load: 70 },
      { kind: "log", setId: "s2", load: 70 },
      { kind: "log", setId: "s3", load: 70 },
      { kind: "log", setId: "d1", load: 50, setType: "drop" },
      { kind: "log", setId: "d2", load: 30, setType: "drop" },
    ];
    const dbPath = tempDbPath();
    try {
      const id = await playSession(ops, "drops").pipe(
        Effect.provide(SqlStore.layer({ filename: dbPath })),
        Effect.scoped,
        Effect.runPromise,
      );
      const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const summary = db
          .prepare(
            `SELECT COUNT(*) AS rows_, SUM(counts_as_set) AS sets,
               MIN(prescribed_exercise_id) AS prescribed, MIN(exercise_id) AS performed,
               COUNT(DISTINCT exercise_id) AS exercises
             FROM logged_set_net WHERE logged_session_id = ?`,
          )
          .get(id) as unknown as {
          rows_: number;
          sets: number;
          prescribed: string;
          performed: string;
          exercises: number;
        };
        expect(summary).toEqual({
          rows_: 5,
          sets: 3,
          prescribed: "exercise-back-squat",
          performed: "exercise-cable-one-arm-curl",
          exercises: 1,
        });
      } finally {
        db.close();
      }
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("an unswapped Entry performs its prescribed exercise", async () => {
    const dbPath = tempDbPath();
    try {
      const id = await playSession([{ kind: "log", setId: "s1", load: 100 }], "plain").pipe(
        Effect.provide(SqlStore.layer({ filename: dbPath })),
        Effect.scoped,
        Effect.runPromise,
      );
      const db = new nodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(
          db
            .prepare("SELECT prescribed_exercise_id, exercise_id, counts_as_set FROM logged_set_net WHERE logged_session_id = ?")
            .get(id),
        ).toEqual({
          prescribed_exercise_id: "exercise-back-squat",
          exercise_id: "exercise-back-squat",
          counts_as_set: 1,
        });
      } finally {
        db.close();
      }
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
