import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { describe, expect, it, vi } from "vitest";

import { foldNetActuals, type LogSetActualInput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/**
 * Rung-1 coverage for `SqlStore` (Step 2A, task 2A.1) — the thing the
 * in-memory `Store` categorically cannot prove: that data survives a
 * process restart. Each test opens a `SqlStore.layer` over a real temp
 * **file** (never `:memory:`), closes it (`Effect.scoped` tears down the
 * `node:sqlite` connection via its scope finalizer — a real `db.close()`),
 * then opens a *fresh* `SqlStore.layer` over the SAME file path and asserts
 * the earlier writes are still there.
 */

const tempDbPath = (): string =>
  path.join(os.tmpdir(), `repcoach-persistence-durability-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const asLogSetActualInput = (input: {
  readonly commandId: string;
  readonly loggedSessionId: string;
  readonly sessionId: string;
  readonly entryId: string;
  readonly setId: string;
  readonly setType: string;
  readonly actual: { readonly reps?: number; readonly load?: number };
}): LogSetActualInput => input as unknown as LogSetActualInput;

const runAgainstFreshLayer = <A, E>(
  dbPath: string,
  // `Scope` because #84's test forks a fiber with `Effect.forkScoped`; the
  // `Effect.scoped` below is what discharges it.
  effect: Effect.Effect<A, E, Store | Scope.Scope>,
): Promise<A> =>
  effect.pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

describe("SqlStore durability (Step 2A / task 2A.1)", () => {
  it("a logged actual survives closing the store and reopening a fresh SqlStore over the same file", async () => {
    const dbPath = tempDbPath();
    try {
      // "Process 1": start a real Logged Session (2A.2) then log an actual
      // against it, then the layer's scope closes (the `node:sqlite`
      // connection is closed for real).
      const firstResult = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const input = asLogSetActualInput({
            commandId: "durability-cmd-1",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-1",
            setType: "working",
            actual: { reps: 5, load: 100 },
          });
          return yield* store.logSetActual(input);
        }),
      );

      // "Process 2": a BRAND NEW `SqlStore.layer` over the identical file
      // path — no shared in-process state with process 1 whatsoever.
      const [actualsAfterReopen, appliedCountAfterReopen] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const actuals = yield* store.listActuals;
          const count = yield* store.appliedCount;
          return [actuals, count] as const;
        }),
      );

      expect(actualsAfterReopen.map((a) => a.commandId)).toContain("durability-cmd-1");
      expect(actualsAfterReopen.find((a) => a.commandId === "durability-cmd-1")).toEqual(firstResult);
      expect(appliedCountAfterReopen).toBe(1);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // #115 item 1 (ADR 0017) — an unplanned Set ("another straight set") is a
  // `setId` naming no prescribed Set at all. The write path has no FK/lookup
  // against the prescribed tree, so this must durably round-trip identically
  // to a prescribed Set's actual, including `entryId` — the field the
  // "another straight set" render derivation needs after a reload.
  it("an unplanned Set's actual (a setId with no prescribed Set) survives closing and reopening the store, with its entryId intact", async () => {
    const dbPath = tempDbPath();
    try {
      const loggedSessionId = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const input = asLogSetActualInput({
            commandId: "durability-unplanned-cmd-1",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-unplanned-durability-1",
            setType: "working",
            actual: { reps: 6, load: 100 },
          });
          yield* store.logSetActual(input);
          return loggedSessionId;
        }),
      );

      const reopenedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId);
        }),
      );

      expect(Option.isSome(reopenedSession)).toBe(true);
      if (!Option.isSome(reopenedSession)) return;

      const actual = reopenedSession.value.actuals.find((a) => a.setId === "set-unplanned-durability-1");
      expect(actual).toBeDefined();
      expect(actual?.entryId).toBe("entry-1");
      expect(actual !== undefined && !actual.retraction && actual.actual).toEqual({ reps: 6, load: 100 });

      const prescribedSetIds = reopenedSession.value.session.blocks.flatMap((block) =>
        block.entries.flatMap((entry) => entry.sets.map((set) => set.id)),
      );
      expect(prescribedSetIds).not.toContain("set-unplanned-durability-1");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // Issue #130, migration `018` — an Entry-anchored note round-trips through
  // `getLoggedSession`'s `notes` field, and a replayed `commandId` (the
  // outbox retrying after a reconnect) lands on the SAME row rather than
  // duplicating it — `commandId` doubles as the row's own `id`, so this is
  // exercising the table's PRIMARY KEY, not a bespoke dedupe column.
  it("an Entry-anchored note survives closing and reopening the store, and a replayed commandId does not duplicate it", async () => {
    const dbPath = tempDbPath();
    try {
      const loggedSessionId = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const input = {
            text: "left elbow twinged on set 3",
            recordedAt: "2026-08-19T08:00:00.000Z",
            entryId: "entry-1",
            loggedSessionId,
            commandId: "durability-note-cmd-1",
          } as never;
          // Replayed twice, as the outbox would after a reconnect it never
          // heard the first ack for — both calls must return the identical
          // note, and only one row must land.
          const first = yield* store.addContextNote(input);
          const second = yield* store.addContextNote(input);
          expect(second).toEqual(first);
          return loggedSessionId;
        }),
      );

      const reopenedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId);
        }),
      );

      expect(Option.isSome(reopenedSession)).toBe(true);
      if (!Option.isSome(reopenedSession)) return;

      expect(reopenedSession.value.notes).toHaveLength(1);
      const note = reopenedSession.value.notes[0];
      expect(note?.id).toBe("durability-note-cmd-1");
      expect(note?.text).toBe("left elbow twinged on set 3");
      expect(note?.entryId).toBe("entry-1");
      expect(note?.loggedSessionId).toBe(loggedSessionId);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // UAT — the note item rewrites rather than appends, so the row has to
  // change text in place and stay ONE row. Two things are load-bearing here
  // and neither is visible from the in-memory store: the rewrite is durable
  // (it survives reopening the file, i.e. it is not just a cache mutation),
  // and `recorded_at` is untouched, which is what keeps the note where it
  // belongs in the Session's timeline for `seedContext`'s "recent notes"
  // window.
  it("a note rewrite replaces the text in place, durably, without moving the note in time or adding a row", async () => {
    const dbPath = tempDbPath();
    try {
      const loggedSessionId = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.addContextNote({
            text: "left elbow twinged on set 3",
            recordedAt: "2026-08-25T08:00:00.000Z",
            entryId: "entry-1",
            loggedSessionId,
            commandId: "edit-note-cmd-1",
          } as never);
          const edited = yield* store.editContextNote({
            commandId: "edit-cmd-1",
            noteId: "edit-note-cmd-1",
            text: "left elbow twinged, fine after the warmup",
          } as never);
          expect(edited?.text).toBe("left elbow twinged, fine after the warmup");
          // Replayed, as the outbox would after a reconnect it never heard
          // the ack for: the command carries the whole text, so re-applying
          // it lands the same row in the same state.
          const replayed = yield* store.editContextNote({
            commandId: "edit-cmd-1",
            noteId: "edit-note-cmd-1",
            text: "left elbow twinged, fine after the warmup",
          } as never);
          expect(replayed).toEqual(edited);

          // A `noteId` naming no row is a no-op SUCCESS, never a failure —
          // an outbox command that could fail permanently here would wedge
          // every write queued behind it.
          const missing = yield* store.editContextNote({
            commandId: "edit-cmd-2",
            noteId: "no-such-note",
            text: "into the void",
          } as never);
          expect(missing).toBeUndefined();
          return loggedSessionId;
        }),
      );

      const reopenedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId);
        }),
      );

      expect(Option.isSome(reopenedSession)).toBe(true);
      if (!Option.isSome(reopenedSession)) return;

      expect(reopenedSession.value.notes).toHaveLength(1);
      const note = reopenedSession.value.notes[0];
      expect(note?.id).toBe("edit-note-cmd-1");
      expect(note?.text).toBe("left elbow twinged, fine after the warmup");
      expect(note?.recordedAt).toBe("2026-08-25T08:00:00.000Z");
      expect(note?.entryId).toBe("entry-1");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // #131, ADR 0019 — a swap survives closing and reopening the store, and
  // the frozen prescribed exercise (inside `session`) stays legible
  // alongside it: both the prescribed and the performed identity are
  // readable off the same `getLoggedSession` response, months later.
  it("a swap survives closing the store and reopening a fresh SqlStore over the same file, with the prescribed exercise still legible", async () => {
    const dbPath = tempDbPath();
    try {
      const loggedSessionId = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.swapEntryExercise({
            commandId: "durability-swap-cmd-1",
            loggedSessionId,
            entryId: "entry-1",
            exerciseId: "exercise-swapped-1",
          } as never);
          return loggedSessionId;
        }),
      );

      const reopenedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId);
        }),
      );

      expect(Option.isSome(reopenedSession)).toBe(true);
      if (!Option.isSome(reopenedSession)) return;

      expect(reopenedSession.value.swaps).toHaveLength(1);
      expect(reopenedSession.value.swaps[0]).toMatchObject({
        commandId: "durability-swap-cmd-1",
        entryId: "entry-1",
        exerciseId: "exercise-swapped-1",
      });

      // The frozen prescribed copy is untouched — the coach can read both
      // the prescribed and the performed exercise off this one response.
      const entry1 = reopenedSession.value.session.blocks
        .flatMap((block) => block.entries)
        .find((entry) => entry.id === "entry-1");
      expect(entry1?.exerciseId).not.toBe("exercise-swapped-1");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // #129 item 2 — a continuation (drop/rest-pause/myo-cluster) is also an
  // unplanned Set whose `setType` must survive a restart, so the client can
  // reconstruct it as the SAME kind of Set rather than downgrading it to a
  // working set. Same shape as the unplanned-straight-set test above, this
  // time asserting `setType` rather than `entryId`.
  it("a logged continuation's setType (drop) survives closing and reopening the store", async () => {
    const dbPath = tempDbPath();
    try {
      const loggedSessionId = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const input = asLogSetActualInput({
            commandId: "durability-drop-cmd-1",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-drop-durability-1",
            setType: "drop",
            actual: { reps: 8, load: 60 },
          });
          yield* store.logSetActual(input);
          return loggedSessionId;
        }),
      );

      const reopenedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId);
        }),
      );

      expect(Option.isSome(reopenedSession)).toBe(true);
      if (!Option.isSome(reopenedSession)) return;

      const actual = reopenedSession.value.actuals.find((a) => a.setId === "set-drop-durability-1");
      expect(actual).toBeDefined();
      expect(actual !== undefined && !actual.retraction && actual.setType).toBe("drop");
      expect(actual !== undefined && !actual.retraction && actual.actual).toEqual({ reps: 8, load: 60 });
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("swapEntryExercise is idempotent by commandId on both Store layers, and does not create a second row on replay", async () => {
    const swapInput = {
      commandId: "swap-idempotency-cmd-1",
      loggedSessionId: "logged-session-placeholder",
      entryId: "entry-1",
      exerciseId: "exercise-swapped-2",
    };

    const inMemoryResults = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      const first = yield* store.swapEntryExercise({ ...swapInput, loggedSessionId } as never);
      const second = yield* store.swapEntryExercise({ ...swapInput, loggedSessionId } as never);
      return [first, second] as const;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(inMemoryResults[0]).toEqual(inMemoryResults[1]);

    const dbPath = tempDbPath();
    try {
      const sqlResults = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const first = yield* store.swapEntryExercise({ ...swapInput, loggedSessionId } as never);
          const second = yield* store.swapEntryExercise({ ...swapInput, loggedSessionId } as never);
          const after = yield* store.getLoggedSession(loggedSessionId);
          return [first, second, Option.isSome(after) ? after.value.swaps.length : -1] as const;
        }),
      );
      expect(sqlResults[0]).toEqual(sqlResults[1]);
      expect(sqlResults[2]).toBe(1);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("swapEntryExercise fails with EntryAlreadyLoggedError on both Store layers once the Entry has a logged Set, and does not record the swap", async () => {
    const inMemoryExit = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.logSetActual(
        asLogSetActualInput({
          commandId: "in-memory-swap-guard",
          loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
      );
      const exit = yield* Effect.exit(
        store.swapEntryExercise({
          commandId: "in-memory-swap-guard-cmd",
          loggedSessionId,
          entryId: "entry-1",
          exerciseId: "exercise-swapped-3",
        } as never),
      );
      const after = yield* store.getLoggedSession(loggedSessionId);
      return [exit, Option.isSome(after) ? after.value.swaps.length : -1] as const;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(inMemoryExit[0]._tag).toBe("Failure");
    expect(inMemoryExit[1]).toBe(0);

    const dbPath = tempDbPath();
    try {
      const sqlExit = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.logSetActual(
            asLogSetActualInput({
              commandId: "sql-swap-guard",
              loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
          );
          const exit = yield* Effect.exit(
            store.swapEntryExercise({
              commandId: "sql-swap-guard-cmd",
              loggedSessionId,
              entryId: "entry-1",
              exerciseId: "exercise-swapped-3",
            } as never),
          );
          const after = yield* store.getLoggedSession(loggedSessionId);
          return [exit, Option.isSome(after) ? after.value.swaps.length : -1] as const;
        }),
      );
      expect(sqlExit[0]._tag).toBe("Failure");
      expect(sqlExit[1]).toBe(0);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // #148 — the swap guard counts NET state, not raw `logged_set_actual` rows.
  // A retraction (migration `021`) is a row in that table too, so the old
  // `COUNT(*)` refused a swap forever after a Set was logged then un-logged,
  // while `Grid.canSwapEntry` on the client — which folds to net state — kept
  // offering the affordance. Both Store layers must now agree with the fold.
  {
    type SwapGuardOp = { readonly setId: string; readonly kind: "log" | "unlog" };
    const scenarios: ReadonlyArray<{ readonly name: string; readonly ops: ReadonlyArray<SwapGuardOp> }> = [
      { name: "nothing logged → allowed", ops: [] },
      { name: "log → refused", ops: [{ setId: "s1", kind: "log" }] },
      {
        name: "log → un-log → allowed (the #148 bug)",
        ops: [
          { setId: "s1", kind: "log" },
          { setId: "s1", kind: "unlog" },
        ],
      },
      {
        name: "log → un-log → log → still refused",
        ops: [
          { setId: "s1", kind: "log" },
          { setId: "s1", kind: "unlog" },
          { setId: "s1", kind: "log" },
        ],
      },
      {
        name: "two Sets, one still logged → refused",
        ops: [
          { setId: "s1", kind: "log" },
          { setId: "s2", kind: "log" },
          { setId: "s1", kind: "unlog" },
        ],
      },
      {
        name: "two Sets, both un-logged → allowed",
        ops: [
          { setId: "s1", kind: "log" },
          { setId: "s2", kind: "log" },
          { setId: "s1", kind: "unlog" },
          { setId: "s2", kind: "unlog" },
        ],
      },
    ];

    /** The verdict the shared fold (`@repcoach/contracts`) reaches for a scenario. */
    const foldSaysRefused = (ops: ReadonlyArray<SwapGuardOp>): boolean =>
      foldNetActuals(ops.map((op) => ({ setId: op.setId as never, retraction: op.kind === "unlog" })))
        .size > 0;

    const runScenario = (ops: ReadonlyArray<SwapGuardOp>) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
        let seq = 0;
        for (const op of ops) {
          seq += 1;
          if (op.kind === "log") {
            yield* store.logSetActual(
              asLogSetActualInput({
                commandId: `guard-${op.setId}-log-${seq}`,
                loggedSessionId,
                sessionId: SEEDED_SESSION_ID,
                entryId: "entry-1",
                setId: op.setId,
                setType: "working",
                actual: { reps: 5, load: 100 },
              }),
            );
          } else {
            yield* store.unlogSetActual({
              commandId: `guard-${op.setId}-unlog-${seq}`,
              loggedSessionId,
              entryId: "entry-1",
              setId: op.setId,
            } as never);
          }
          // The guard orders by `(applied_at, id)` — the same order
          // `getLoggedSession` reads rows back in. Space the writes so a
          // same-millisecond `applied_at` collision (with a non-monotonic uuid
          // tiebreak) can't reorder ops on one `setId` and flip the verdict.
          yield* Effect.sleep(3);
        }
        const exit = yield* Effect.exit(
          store.swapEntryExercise({
            commandId: "guard-swap-cmd",
            loggedSessionId,
            entryId: "entry-1",
            exerciseId: "exercise-swapped-1",
          } as never),
        );
        const after = yield* store.getLoggedSession(loggedSessionId);
        return {
          refused: exit._tag === "Failure",
          swapRows: Option.isSome(after) ? after.value.swaps.length : -1,
        };
      });

    for (const scenario of scenarios) {
      it(`swap guard — ${scenario.name} — agrees with foldNetActuals on both Store layers`, async () => {
        const expectedRefused = foldSaysRefused(scenario.ops);

        const inMemory = await runScenario(scenario.ops).pipe(
          Effect.provide(Store.layer),
          Effect.scoped,
          Effect.runPromise,
        );
        expect(inMemory.refused).toBe(expectedRefused);
        expect(inMemory.swapRows).toBe(expectedRefused ? 0 : 1);

        const dbPath = tempDbPath();
        try {
          const sql = await runAgainstFreshLayer(dbPath, runScenario(scenario.ops));
          expect(sql.refused).toBe(expectedRefused);
          expect(sql.swapRows).toBe(expectedRefused ? 0 : 1);
        } finally {
          cleanupDbFile(dbPath);
        }
      });
    }
  }

  it("a Plan mutation survives closing the store and reopening a fresh SqlStore over the same file", async () => {
    const dbPath = tempDbPath();
    try {
      // "Process 1": bump the seeded session's load targets via the same
      // test-only lever the frozen-in-flight rung-1 test (Task 5) uses.
      const mutated = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.mutatePrescribedSessionForTest(SEEDED_SESSION_ID);
        }),
      );
      const mutatedLoadMax = mutated._tag === "Some" ? mutated.value.blocks[0]?.entries[0]?.sets[0]?.target.load?.max : undefined;
      expect(mutatedLoadMax).toBe(105); // seeded 100 + the test lever's +5

      // "Process 2": a fresh SqlStore over the same file must see the
      // MUTATED value, not the original seed — proving this is real
      // persistence, not just the deterministic seed reappearing by
      // coincidence (a reseed-on-reopen bug would silently revert to 100).
      const reopened = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const session = yield* store.getPrescribedSession(SEEDED_SESSION_ID);
          return session;
        }),
      );

      expect(reopened._tag).toBe("Some");
      const reopenedLoadMax =
        reopened._tag === "Some" ? reopened.value.blocks[0]?.entries[0]?.sets[0]?.target.load?.max : undefined;
      expect(reopenedLoadMax).toBe(105);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // 2B slice 4 (issue #29) — `finalizeSession` ("Finish Workout"'s status
  // transition) round-trips on the SqlStore layer, not just in-memory.
  it("finalizeSession flips logged_session.status to 'finished' and survives closing/reopening the store", async () => {
    const dbPath = tempDbPath();
    try {
      const finalizedResult = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          return yield* store.finalizeSession(loggedSessionId);
        }),
      );
      expect(Option.isSome(finalizedResult)).toBe(true);
      const finalizedStatus = Option.isSome(finalizedResult) ? finalizedResult.value.status : undefined;
      expect(finalizedStatus).toBe("finished");

      const loggedSessionId =
        Option.isSome(finalizedResult) ? (finalizedResult.value.loggedSessionId as string) : undefined;
      expect(loggedSessionId).toBeDefined();

      const reopenedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId as never);
        }),
      );
      expect(Option.isSome(reopenedSession)).toBe(true);
      expect(Option.isSome(reopenedSession) ? reopenedSession.value.status : undefined).toBe("finished");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("finalizeSession round-trips on the in-memory Store layer too (mirrors the SqlStore assertion above)", async () => {
    const [finalizedResult, reopenedStatus] = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      const finalizedResult = yield* store.finalizeSession(loggedSessionId);
      const reopened = yield* store.getLoggedSession(loggedSessionId);
      const reopenedStatus = Option.isSome(reopened) ? reopened.value.status : undefined;
      return [finalizedResult, reopenedStatus] as const;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(Option.isSome(finalizedResult) ? finalizedResult.value.status : undefined).toBe("finished");
    expect(reopenedStatus).toBe("finished");
  });

  it("finalizeSession returns None for an unknown loggedSessionId on both Store layers", async () => {
    const inMemoryResult = await Effect.gen(function* () {
      const store = yield* Store;
      return yield* store.finalizeSession("does-not-exist" as never);
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(Option.isNone(inMemoryResult)).toBe(true);

    const dbPath = tempDbPath();
    try {
      const sqlResult = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.finalizeSession("does-not-exist" as never);
        }),
      );
      expect(Option.isNone(sqlResult)).toBe(true);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // Issue #114 Part 1 — "Cancel session" round-trips on the SqlStore layer,
  // not just in-memory (mirrors `finalizeSession`'s durability coverage
  // above).
  it("cancelSession flips logged_session.status to 'cancelled' and survives closing/reopening the store", async () => {
    const dbPath = tempDbPath();
    try {
      const cancelResult = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          return yield* store.cancelSession(loggedSessionId);
        }),
      );
      expect(Option.isSome(cancelResult)).toBe(true);
      const cancelValue = Option.isSome(cancelResult) ? cancelResult.value : undefined;
      expect(cancelValue?.status).toBe("cancelled");
      expect(cancelValue?.cancelled).toBe(true);

      const loggedSessionId = cancelValue?.loggedSessionId as string | undefined;
      expect(loggedSessionId).toBeDefined();

      const reopenedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId as never);
        }),
      );
      expect(Option.isSome(reopenedSession)).toBe(true);
      expect(Option.isSome(reopenedSession) ? reopenedSession.value.status : undefined).toBe("cancelled");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("cancelSession with zero actuals succeeds on both Store layers", async () => {
    const inMemoryResult = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      return yield* store.cancelSession(loggedSessionId);
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(Option.isSome(inMemoryResult) ? inMemoryResult.value.cancelled : undefined).toBe(true);

    const dbPath = tempDbPath();
    try {
      const sqlResult = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          return yield* store.cancelSession(loggedSessionId);
        }),
      );
      expect(Option.isSome(sqlResult) ? sqlResult.value.cancelled : undefined).toBe(true);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("cancelSession with a logged actual fails with LoggedSessionHasActualsError on both Store layers, and does not cancel", async () => {
    const inMemoryExit = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.logSetActual(
        asLogSetActualInput({
          commandId: "in-memory-cancel-guard",
          loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
      );
      const exit = yield* Effect.exit(store.cancelSession(loggedSessionId));
      const after = yield* store.getLoggedSession(loggedSessionId);
      return [exit, Option.isSome(after) ? after.value.status : undefined] as const;
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(inMemoryExit[0]._tag).toBe("Failure");
    expect(inMemoryExit[1]).toBe("active");

    const dbPath = tempDbPath();
    try {
      const sqlExit = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.logSetActual(
            asLogSetActualInput({
              commandId: "sql-cancel-guard",
              loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
          );
          const exit = yield* Effect.exit(store.cancelSession(loggedSessionId));
          const after = yield* store.getLoggedSession(loggedSessionId);
          return [exit, Option.isSome(after) ? after.value.status : undefined] as const;
        }),
      );
      expect(sqlExit[0]._tag).toBe("Failure");
      expect(sqlExit[1]).toBe("active");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("cancelSession is idempotent on both Store layers: a second cancel is a no-op, not a failure", async () => {
    const inMemoryResult = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.cancelSession(loggedSessionId);
      return yield* store.cancelSession(loggedSessionId);
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(Option.isSome(inMemoryResult) ? inMemoryResult.value.cancelled : undefined).toBe(false);
    expect(Option.isSome(inMemoryResult) ? inMemoryResult.value.status : undefined).toBe("cancelled");

    const dbPath = tempDbPath();
    try {
      const sqlResult = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.cancelSession(loggedSessionId);
          return yield* store.cancelSession(loggedSessionId);
        }),
      );
      expect(Option.isSome(sqlResult) ? sqlResult.value.cancelled : undefined).toBe(false);
      expect(Option.isSome(sqlResult) ? sqlResult.value.status : undefined).toBe("cancelled");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // Issue #114 Part 2 — "History": `listSessions` excludes `active` and
  // `cancelled` rows, ordering the rest newest-first by `finished_at`.
  it("listSessions excludes active/cancelled sessions and orders finished sessions newest-first, on both Store layers", async () => {
    const inMemory = await Effect.gen(function* () {
      const store = yield* Store;
      const cancelled = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.cancelSession(cancelled.loggedSessionId);
      const stillActive = yield* store.startSession(SEEDED_SESSION_ID as never);
      const older = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.finalizeSession(older.loggedSessionId);
      yield* Effect.sleep("5 millis");
      const newer = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.finalizeSession(newer.loggedSessionId);
      const result = yield* store.listSessions({});
      return { result, cancelled, stillActive, older, newer };
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    const ids = inMemory.result.sessions.map((s) => s.loggedSessionId as string);
    expect(ids).not.toContain(inMemory.cancelled.loggedSessionId as string);
    expect(ids).not.toContain(inMemory.stillActive.loggedSessionId as string);
    expect(ids.indexOf(inMemory.newer.loggedSessionId as string)).toBeLessThan(
      ids.indexOf(inMemory.older.loggedSessionId as string),
    );

    const dbPath = tempDbPath();
    try {
      const sql = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const cancelled = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.cancelSession(cancelled.loggedSessionId);
          const stillActive = yield* store.startSession(SEEDED_SESSION_ID as never);
          const older = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.finalizeSession(older.loggedSessionId);
          yield* Effect.sleep("5 millis");
          const newer = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.finalizeSession(newer.loggedSessionId);
          const result = yield* store.listSessions({});
          return { result, cancelled, stillActive, older, newer };
        }),
      );
      const sqlIds = sql.result.sessions.map((s) => s.loggedSessionId as string);
      expect(sqlIds).not.toContain(sql.cancelled.loggedSessionId as string);
      expect(sqlIds).not.toContain(sql.stillActive.loggedSessionId as string);
      expect(sqlIds.indexOf(sql.newer.loggedSessionId as string)).toBeLessThan(
        sqlIds.indexOf(sql.older.loggedSessionId as string),
      );
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("lastActualForExercise resolves swap-aware, net-state, newest-wins on both Store layers (issue #149)", async () => {
    // entry-1 is prescribed back-squat; entry-2 (bench-press) is SWAPPED to
    // back-squat here, so set-3 also counts toward back-squat's history and,
    // being the most recent log, its load wins. set-2's log is retracted, so
    // it contributes nothing. bench-press was swapped away — nothing was
    // performed as bench-press, so it resolves to {}.
    const drive = Effect.gen(function* () {
        const store = yield* Store;
        const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
        yield* store.logSetActual(
          asLogSetActualInput({
            commandId: "i149-1",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-1",
            setType: "working",
            actual: { reps: 5, load: 98 },
          }),
        );
        yield* store.logSetActual(
          asLogSetActualInput({
            commandId: "i149-2",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-2",
            setType: "working",
            actual: { reps: 5, load: 999 },
          }),
        );
        yield* store.unlogSetActual({
          commandId: "i149-2-retract",
          loggedSessionId,
          entryId: "entry-1",
          setId: "set-2",
        } as never);
        yield* store.swapEntryExercise({
          commandId: "i149-swap",
          loggedSessionId,
          entryId: "entry-2",
          exerciseId: "exercise-back-squat",
        } as never);
        yield* store.logSetActual(
          asLogSetActualInput({
            commandId: "i149-3",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-2",
            setId: "set-3",
            setType: "working",
            actual: { reps: 9, load: 70 },
          }),
        );
        yield* store.finalizeSession(loggedSessionId);
        const backSquat = yield* store.lastActualForExercise({
          exerciseId: "exercise-back-squat" as never,
        });
        const benchPress = yield* store.lastActualForExercise({
          exerciseId: "exercise-bench-press" as never,
        });
        return { backSquat, benchPress };
      });

    const inMemory = await drive.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);
    expect(inMemory.backSquat.perMetric).toEqual({ reps: 9, load: 70 });
    expect(inMemory.benchPress.perMetric).toEqual({});
    // Set by Set, in Entry order — the retracted set-2 is gone (UAT).
    const backSquatSets = [
      { setType: "working", actual: { reps: 5, load: 98 } },
      { setType: "working", actual: { reps: 9, load: 70 } },
    ];
    expect(inMemory.backSquat.sets.map(({ setType, actual }) => ({ setType, actual }))).toEqual(backSquatSets);
    expect(inMemory.benchPress.sets).toEqual([]);

    const dbPath = tempDbPath();
    try {
      const sql = await runAgainstFreshLayer(dbPath, drive);
      expect(sql.backSquat.perMetric).toEqual({ reps: 9, load: 70 });
      expect(sql.benchPress.perMetric).toEqual({});
      expect(sql.backSquat.sets.map(({ setType, actual }) => ({ setType, actual }))).toEqual(backSquatSets);
      expect(sql.benchPress.sets).toEqual([]);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // Issue #147 — "Resume is a localStorage pointer only": `listActiveSessions`
  // is the server-side source of truth for a workout in flight. The mirror
  // image of `listSessions`: only `active` rows, newest `started_at` first,
  // with the NET still-logged Set count.
  const listActiveSessionsProgram = Effect.gen(function* () {
    const store = yield* Store;
    const finished = yield* store.startSession(SEEDED_SESSION_ID as never);
    yield* store.finalizeSession(finished.loggedSessionId);
    const cancelled = yield* store.startSession(SEEDED_SESSION_ID as never);
    yield* store.cancelSession(cancelled.loggedSessionId);

    const older = yield* store.startSession(SEEDED_SESSION_ID as never);
    yield* Effect.sleep("5 millis");
    const newer = yield* store.startSession(SEEDED_SESSION_ID as never);

    // Two logs then a retraction of one, on `older` — the net count must be 1.
    yield* store.logSetActual(
      asLogSetActualInput({
        commandId: "active-a",
        loggedSessionId: older.loggedSessionId,
        sessionId: SEEDED_SESSION_ID,
        entryId: "entry-1",
        setId: "set-1",
        setType: "working",
        actual: { reps: 5, load: 100 },
      }),
    );
    yield* store.logSetActual(
      asLogSetActualInput({
        commandId: "active-b",
        loggedSessionId: older.loggedSessionId,
        sessionId: SEEDED_SESSION_ID,
        entryId: "entry-1",
        setId: "set-2",
        setType: "working",
        actual: { reps: 5, load: 100 },
      }),
    );
    yield* store.unlogSetActual({
      commandId: "active-c" as never,
      loggedSessionId: older.loggedSessionId,
      entryId: "entry-1" as never,
      setId: "set-2" as never,
    });

    const result = yield* store.listActiveSessions;
    return { result, older, newer, finished, cancelled };
  });

  const assertActiveShape = (r: {
    readonly result: { readonly sessions: ReadonlyArray<{ readonly loggedSessionId: string; readonly prescribedSessionId: string; readonly loggedSetCount: number }> };
    readonly older: { readonly loggedSessionId: string };
    readonly newer: { readonly loggedSessionId: string };
    readonly finished: { readonly loggedSessionId: string };
    readonly cancelled: { readonly loggedSessionId: string };
  }) => {
    const ids = r.result.sessions.map((s) => s.loggedSessionId);
    expect(ids).toEqual([r.newer.loggedSessionId, r.older.loggedSessionId]);
    expect(ids).not.toContain(r.finished.loggedSessionId);
    expect(ids).not.toContain(r.cancelled.loggedSessionId);
    const olderRow = r.result.sessions.find((s) => s.loggedSessionId === r.older.loggedSessionId);
    expect(olderRow?.loggedSetCount).toBe(1);
    expect(olderRow?.prescribedSessionId).toBe(SEEDED_SESSION_ID);
  };

  it("listActiveSessions returns only active sessions, newest-first, with the net logged-set count (in-memory Store)", async () => {
    const r = await listActiveSessionsProgram.pipe(
      Effect.provide(Store.layer),
      Effect.scoped,
      Effect.runPromise,
    );
    assertActiveShape(r as never);
  });

  it("listActiveSessions behaves identically on the SqlStore layer", async () => {
    const dbPath = tempDbPath();
    try {
      const r = await runAgainstFreshLayer(dbPath, listActiveSessionsProgram);
      assertActiveShape(r as never);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // `applied_at` is millisecond-resolution and `id` is a random UUID, so a log
  // and its un-log landing in the same millisecond (routine on a fast CI box)
  // must fall back to insertion order — `rowid`, per ADR 0019 — not to UUID
  // order, which made the net count a coin flip.
  it("listActiveSessions nets a same-millisecond log-then-unlog by insertion order on the SqlStore layer", async () => {
    const dbPath = tempDbPath();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      for (let run = 0; run < 8; run++) {
        const r = await runAgainstFreshLayer(`${dbPath}.${run}`, listActiveSessionsProgram);
        const olderRow = r.result.sessions.find((s) => s.loggedSessionId === r.older.loggedSessionId);
        expect(olderRow?.loggedSetCount).toBe(1);
      }
    } finally {
      vi.useRealTimers();
      for (let run = 0; run < 8; run++) cleanupDbFile(`${dbPath}.${run}`);
    }
  });

  it("logSetActual is idempotent by commandId at the DB layer: a replay returns the same stored row, only one row", async () => {
    const dbPath = tempDbPath();
    try {
      const [first, second, appliedCount, loggedSessionId] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId: startedLoggedSessionId } = yield* store.startSession(
            SEEDED_SESSION_ID as never,
          );
          const input = asLogSetActualInput({
            commandId: "idempotent-cmd-1",
            loggedSessionId: startedLoggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-1",
            setType: "working",
            actual: { reps: 5, load: 100 },
          });
          const a = yield* store.logSetActual(input);
          const b = yield* store.logSetActual(input);
          const count = yield* store.appliedCount;
          return [a, b, count, startedLoggedSessionId] as const;
        }),
      );

      expect(second).toEqual(first);
      expect(appliedCount).toBe(1);

      // And a THIRD replay, after the DB is closed and reopened, still
      // returns the identical canonical row (the UNIQUE(command_id)
      // constraint holds across restarts, not just within one process) —
      // the `logged_session` row from "process 1" is durable too, so the
      // same `loggedSessionId` remains a valid FK target.
      const [thirdAfterReopen, appliedCountAfterReopen] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const input = asLogSetActualInput({
            commandId: "idempotent-cmd-1",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-1",
            setType: "working",
            actual: { reps: 5, load: 100 },
          });
          const c = yield* store.logSetActual(input);
          const count = yield* store.appliedCount;
          return [c, count] as const;
        }),
      );

      expect(thirdAfterReopen).toEqual(first);
      expect(appliedCountAfterReopen).toBe(1);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("concurrent duplicate logSetActual calls collapse to a single stored actual (same as the in-memory store)", async () => {
    const dbPath = tempDbPath();
    try {
      const [results, appliedCount] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          const input = asLogSetActualInput({
            commandId: "idempotent-concurrent-1",
            loggedSessionId,
            sessionId: SEEDED_SESSION_ID,
            entryId: "entry-1",
            setId: "set-1",
            setType: "working",
            actual: { reps: 5, load: 100 },
          });
          const all = yield* Effect.all(
            [store.logSetActual(input), store.logSetActual(input), store.logSetActual(input)],
            { concurrency: "unbounded" },
          );
          const count = yield* store.appliedCount;
          return [all, count] as const;
        }),
      );

      const [firstResult, ...rest] = results;
      for (const result of rest) {
        expect(result).toEqual(firstResult);
      }
      expect(appliedCount).toBe(1);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("seeds the plan/prescribed session/exercise catalog on first open, matching the in-memory store's seed", async () => {
    const dbPath = tempDbPath();
    try {
      const [plan, feed, proposals] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const p = yield* store.getPlan;
          const f = yield* store.getCoachingFeed;
          const props = yield* store.getProposals;
          return [p, f, props] as const;
        }),
      );

      expect(plan.sessions[0]?.id).toBe(SEEDED_SESSION_ID);
      expect(plan.sessions[0]?.blocks).toHaveLength(3);
      expect(feed[0]?.id).toBe("feed-1");
      expect(proposals[0]?.id).toBe("proposal-1");
      expect(proposals[0]?.status).toBe("pending");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("reopening over the same file does NOT wipe/reseed an already-seeded database", async () => {
    const dbPath = tempDbPath();
    try {
      // Open once (seeds), resolve a Proposal so the Plan diverges from the
      // raw seed shape.
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.resolveProposal({ proposalId: "proposal-1" as never, decision: "accepted" });
        }),
      );

      // Reopen: if the store re-seeded instead of reusing existing data,
      // the Proposal would be back to `pending` and the Plan's load bump
      // would be gone.
      const [proposals, plan] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const props = yield* store.getProposals;
          const p = yield* store.getPlan;
          return [props, p] as const;
        }),
      );

      expect(proposals.find((p) => p.id === "proposal-1")?.status).toBe("accepted");
      expect(plan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max).toBe(102.5);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("rejecting a Proposal retains it as 'rejected' and leaves the Plan untouched — durably across a reopen (task 2A.4)", async () => {
    const dbPath = tempDbPath();
    try {
      // Capture the seed's pre-reject load so the "Plan untouched" assertion
      // compares against the real baseline, not a hard-coded guess.
      const seedLoadMax = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const plan = yield* store.getPlan;
          return plan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max;
        }),
      );

      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.resolveProposal({ proposalId: "proposal-1" as never, decision: "rejected" });
        }),
      );

      // Reopen a fresh layer over the same file: the Proposal must be
      // retained (never deleted — CONTEXT `Change`) with status 'rejected',
      // and the Plan must be byte-for-byte the seed (no mutation on reject,
      // ADR 0008) — both proven from durable storage, not in-process state.
      const [proposals, planLoadMax] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const props = yield* store.getProposals;
          const plan = yield* store.getPlan;
          return [props, plan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max] as const;
        }),
      );

      expect(proposals.find((p) => p.id === "proposal-1")?.status).toBe("rejected");
      expect(planLoadMax).toBe(seedLoadMax);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // --- task 2A.2: real Logged Session instantiation --------------------

  it("startSession snapshots the Prescribed Session at instantiation time — a later Plan edit does not reach it", async () => {
    const dbPath = tempDbPath();
    try {
      const loggedSessionId = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId: id } = yield* store.startSession(SEEDED_SESSION_ID as never);
          return id;
        }),
      );

      // Mutate the seeded Prescribed Session AFTER instantiation — the
      // same test-only lever the frozen-in-flight (Task 5) test uses.
      await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.mutatePrescribedSessionForTest(SEEDED_SESSION_ID);
        }),
      );

      const loggedSession = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession(loggedSessionId);
        }),
      );

      expect(loggedSession._tag).toBe("Some");
      const snapshotLoadMax =
        loggedSession._tag === "Some"
          ? loggedSession.value.session.blocks[0]?.entries[0]?.sets[0]?.target.load?.max
          : undefined;
      // Still 100 — the ORIGINAL seed value, not the mutated 105. Proves the
      // snapshot is a frozen deep copy, not a live reference.
      expect(snapshotLoadMax).toBe(100);
      expect(loggedSession._tag === "Some" ? loggedSession.value.prescribedSessionId : undefined).toBe(
        SEEDED_SESSION_ID,
      );
      expect(loggedSession._tag === "Some" ? loggedSession.value.status : undefined).toBe("active");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("getLoggedSession returns every actual applied against that Logged Session, and none from a different one", async () => {
    const dbPath = tempDbPath();
    try {
      const [loggedSessionA, loggedSessionB] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const a = yield* store.startSession(SEEDED_SESSION_ID as never);
          const b = yield* store.startSession(SEEDED_SESSION_ID as never);

          yield* store.logSetActual(
            asLogSetActualInput({
              commandId: "logged-session-a-cmd-1",
              loggedSessionId: a.loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
          );
          yield* store.logSetActual(
            asLogSetActualInput({
              commandId: "logged-session-a-cmd-2",
              loggedSessionId: a.loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-2",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
          );
          yield* store.logSetActual(
            asLogSetActualInput({
              commandId: "logged-session-b-cmd-1",
              loggedSessionId: b.loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 3, load: 90 },
            }),
          );

          return [a.loggedSessionId, b.loggedSessionId] as const;
        }),
      );

      // Reopen a fresh layer over the same file — proves this reads back
      // from durable storage, not in-process state.
      const [readA, readB] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const a = yield* store.getLoggedSession(loggedSessionA);
          const b = yield* store.getLoggedSession(loggedSessionB);
          return [a, b] as const;
        }),
      );

      expect(readA._tag).toBe("Some");
      expect(readA._tag === "Some" ? readA.value.actuals.map((x) => x.commandId).sort() : []).toEqual([
        "logged-session-a-cmd-1",
        "logged-session-a-cmd-2",
      ]);

      expect(readB._tag).toBe("Some");
      expect(readB._tag === "Some" ? readB.value.actuals.map((x) => x.commandId) : []).toEqual([
        "logged-session-b-cmd-1",
      ]);
      const firstB = readB._tag === "Some" ? readB.value.actuals[0] : undefined;
      expect(firstB !== undefined && !firstB.retraction && firstB.actual).toEqual({
        reps: 3,
        load: 90,
      });
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("getLoggedSession returns None for an unknown loggedSessionId", async () => {
    const dbPath = tempDbPath();
    try {
      const result = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getLoggedSession("does-not-exist" as never);
        }),
      );
      expect(result._tag).toBe("None");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("startSession fails with PrescribedSessionNotFoundError for an unknown prescribedSessionId", async () => {
    const dbPath = tempDbPath();
    try {
      const exit = await Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.startSession("does-not-exist" as never);
      }).pipe(
        Effect.provide(SqlStore.layer({ filename: dbPath })),
        Effect.scoped,
        Effect.exit,
        Effect.runPromise,
      );
      expect(exit._tag).toBe("Failure");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // --- task 2A.3: user-direct Plan edits + catalog-driven grid fields ----

  it("applyUserPlanChange edits a prescribed Set's target, returns the updated Plan, and the edit survives a reopen", async () => {
    const dbPath = tempDbPath();
    try {
      const returnedPlan = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.applyUserPlanChange({
            setId: "set-1" as never,
            target: { reps: { min: 8, max: 8 }, load: { min: 110, max: 110 } } as never,
          });
        }),
      );
      // The success value echoes the new target so a caller can render it
      // without waiting on subscribePlan's next emission.
      expect(returnedPlan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target).toEqual({
        reps: { min: 8, max: 8 },
        load: { min: 110, max: 110 },
      });

      // A fresh layer over the same file must see the edited target, not the
      // seed's 100 — proving the user-direct Change persisted, not just the
      // deterministic seed reappearing.
      const [reopenedPlan, reopenedSession] = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const plan = yield* store.getPlan;
          const session = yield* store.getPrescribedSession(SEEDED_SESSION_ID);
          return [plan, session] as const;
        }),
      );

      expect(reopenedPlan.sessions[0]?.blocks[0]?.entries[0]?.sets[0]?.target.load?.max).toBe(110);
      // getPrescribedSession (the read startSession copies from) sees it too.
      const reopenedSetTarget =
        reopenedSession._tag === "Some"
          ? reopenedSession.value.blocks[0]?.entries[0]?.sets[0]?.target.reps?.max
          : undefined;
      expect(reopenedSetTarget).toBe(8);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("applyUserPlanChange fails with PrescribedSetNotFoundError for an unknown setId", async () => {
    const dbPath = tempDbPath();
    try {
      const exit = await Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.applyUserPlanChange({
          setId: "no-such-set" as never,
          target: { reps: { min: 5, max: 5 } } as never,
        });
      }).pipe(
        Effect.provide(SqlStore.layer({ filename: dbPath })),
        Effect.scoped,
        Effect.exit,
        Effect.runPromise,
      );
      expect(exit._tag).toBe("Failure");
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("getPrescribedSession attaches each Entry's catalog-declared trackedMetrics (drives the grid field layout)", async () => {
    const dbPath = tempDbPath();
    try {
      const session = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          return yield* store.getPrescribedSession(SEEDED_SESSION_ID);
        }),
      );

      expect(session._tag).toBe("Some");
      if (session._tag !== "Some") return;
      // back-squat (entry-1) tracks reps+load; plank (entry-3, block-2)
      // tracks duration only — straight from exercise_catalog seed rows.
      const backSquat = session.value.blocks[0]?.entries[0];
      expect(backSquat?.exerciseId).toBe("exercise-back-squat");
      expect(backSquat?.trackedMetrics).toEqual(["reps", "load"]);
      const plank = session.value.blocks[1]?.entries[1];
      expect(plank?.exerciseId).toBe("exercise-plank");
      expect(plank?.trackedMetrics).toEqual(["duration"]);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  // Issue #117 — "Stats": `getDailySetCounts` buckets by LOCAL calendar day,
  // not the UTC day `applied_at` is stored in. `logSetActualAtForTest` is the
  // only way to put a set on a specific instant without sleeping real time.
  it("getDailySetCounts buckets by local day across the UTC midnight boundary, on both Store layers", async () => {
    // A set applied at 23:50 UTC: at UTC+120 (local = UTC + 2h) that instant
    // is already 01:50 the NEXT local day; at UTC-300 (local = UTC - 5h) it is
    // still 18:50 the SAME local day as the UTC date. Both must move the
    // bucket relative to the naive UTC-date reading.
    const appliedAt = "2026-03-14T23:50:00.000Z";

    const inMemory = await Effect.gen(function* () {
      const store = yield* Store;
      const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.logSetActualAtForTest(
        asLogSetActualInput({
          commandId: "stats-tz-1",
          loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
        appliedAt,
      );
      const aheadOfUtc = yield* store.getDailySetCounts({ utcOffsetMinutes: 120 });
      const behindUtc = yield* store.getDailySetCounts({ utcOffsetMinutes: -300 });
      return { aheadOfUtc, behindUtc };
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(inMemory.aheadOfUtc.days).toEqual([{ date: "2026-03-15", setCount: 1 }]);
    expect(inMemory.behindUtc.days).toEqual([{ date: "2026-03-14", setCount: 1 }]);

    const dbPath = tempDbPath();
    try {
      const sql = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.logSetActualAtForTest(
            asLogSetActualInput({
              commandId: "stats-tz-1",
              loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
            appliedAt,
          );
          const aheadOfUtc = yield* store.getDailySetCounts({ utcOffsetMinutes: 120 });
          const behindUtc = yield* store.getDailySetCounts({ utcOffsetMinutes: -300 });
          return { aheadOfUtc, behindUtc };
        }),
      );
      expect(sql.aheadOfUtc.days).toEqual([{ date: "2026-03-15", setCount: 1 }]);
      expect(sql.behindUtc.days).toEqual([{ date: "2026-03-14", setCount: 1 }]);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("getDailySetCounts excludes actuals belonging to a cancelled session, on both Store layers", async () => {
    const appliedAt = "2026-03-14T12:00:00.000Z";

    const inMemory = await Effect.gen(function* () {
      const store = yield* Store;
      // A live session's set — this one must count.
      const live = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.logSetActualAtForTest(
        asLogSetActualInput({
          commandId: "stats-cancel-live",
          loggedSessionId: live.loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
        appliedAt,
      );
      // A session cancelled while empty (the only way `cancelSession`
      // allows it — issue #114), then an actual injected against it
      // directly: proves the aggregation filters on `status` itself rather
      // than relying on "a cancelled session can never have actuals".
      const cancelled = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.cancelSession(cancelled.loggedSessionId);
      yield* store.logSetActualAtForTest(
        asLogSetActualInput({
          commandId: "stats-cancel-ghost",
          loggedSessionId: cancelled.loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
        appliedAt,
      );
      return yield* store.getDailySetCounts({ utcOffsetMinutes: 0 });
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(inMemory.days).toEqual([{ date: "2026-03-14", setCount: 1 }]);

    const dbPath = tempDbPath();
    try {
      const sql = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const live = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.logSetActualAtForTest(
            asLogSetActualInput({
              commandId: "stats-cancel-live",
              loggedSessionId: live.loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
            appliedAt,
          );
          const cancelled = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.cancelSession(cancelled.loggedSessionId);
          yield* store.logSetActualAtForTest(
            asLogSetActualInput({
              commandId: "stats-cancel-ghost",
              loggedSessionId: cancelled.loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
            appliedAt,
          );
          return yield* store.getDailySetCounts({ utcOffsetMinutes: 0 });
        }),
      );
      expect(sql.days).toEqual([{ date: "2026-03-14", setCount: 1 }]);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("getDailySetCounts dedupes set ids per-session rather than globally, on both Store layers", async () => {
    // Two different Logged Sessions on the same day both log a "set-1" (set
    // ids are per-session/template-derived, not globally unique) — a naive
    // `COUNT(DISTINCT set_id)` would collapse these into 1.
    const appliedAt = "2026-03-14T12:00:00.000Z";

    const inMemory = await Effect.gen(function* () {
      const store = yield* Store;
      const first = yield* store.startSession(SEEDED_SESSION_ID as never);
      const second = yield* store.startSession(SEEDED_SESSION_ID as never);
      yield* store.logSetActualAtForTest(
        asLogSetActualInput({
          commandId: "stats-dedupe-1",
          loggedSessionId: first.loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
        appliedAt,
      );
      yield* store.logSetActualAtForTest(
        asLogSetActualInput({
          commandId: "stats-dedupe-2",
          loggedSessionId: second.loggedSessionId,
          sessionId: SEEDED_SESSION_ID,
          entryId: "entry-1",
          setId: "set-1",
          setType: "working",
          actual: { reps: 5, load: 100 },
        }),
        appliedAt,
      );
      return yield* store.getDailySetCounts({ utcOffsetMinutes: 0 });
    }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

    expect(inMemory.days).toEqual([{ date: "2026-03-14", setCount: 2 }]);

    const dbPath = tempDbPath();
    try {
      const sql = await runAgainstFreshLayer(
        dbPath,
        Effect.gen(function* () {
          const store = yield* Store;
          const first = yield* store.startSession(SEEDED_SESSION_ID as never);
          const second = yield* store.startSession(SEEDED_SESSION_ID as never);
          yield* store.logSetActualAtForTest(
            asLogSetActualInput({
              commandId: "stats-dedupe-1",
              loggedSessionId: first.loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
            appliedAt,
          );
          yield* store.logSetActualAtForTest(
            asLogSetActualInput({
              commandId: "stats-dedupe-2",
              loggedSessionId: second.loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            }),
            appliedAt,
          );
          return yield* store.getDailySetCounts({ utcOffsetMinutes: 0 });
        }),
      );
      expect(sql.days).toEqual([{ date: "2026-03-14", setCount: 2 }]);
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

/**
 * #84 — a command whose ack dies with the socket must still be retirable by
 * a replay, on both `Store` layers.
 *
 * `logSetActual` withholds its response behind an in-process `Deferred` while
 * `pauseAcks` is set (the half-open-link lever both `Store` layers share).
 * The RPC server interrupts every in-flight request fiber when its
 * connection dies (`RpcServer.ts`), so the fiber sitting on `currentPauseGate`
 * for the *first* delivery of a commandId can die before it ever reaches
 * `Deferred.succeed`. Before the fix, that left the commandId's `Deferred`
 * permanently unresolved — a *replay* of the same commandId (landing after a
 * reconnect, on a fiber that finds `isNew: false`) would `Deferred.await` a
 * value nothing would ever produce, hanging forever even though the original
 * write had already landed durably. `Effect.ensuring` on the pause-gate wait
 * guarantees the slot's `Deferred` completes once `result` is known,
 * regardless of how that wait exits.
 */
describe("logSetActual survives its first delivery's fiber dying mid-ack (#84)", () => {
  it("a replayed commandId resolves instead of hanging forever, on both Store layers", async () => {
    const dbPath = tempDbPath();
    try {
      const exerciseLayer = async (
        provideLayer: <A, E>(effect: Effect.Effect<A, E, Store | Scope.Scope>) => Promise<A>,
        commandId: string,
      ) => {
        const outcome = await provideLayer(
          Effect.gen(function* () {
            const store = yield* Store;
            const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
            const input = asLogSetActualInput({
              commandId,
              loggedSessionId,
              sessionId: SEEDED_SESSION_ID,
              entryId: "entry-1",
              setId: "set-1",
              setType: "working",
              actual: { reps: 5, load: 100 },
            });

            yield* store.pauseAcks;

            // The "first delivery": its fiber will die mid-wait, simulating
            // the connection that carried it closing before the ack could be
            // withheld-then-sent.
            const firstDelivery = yield* Effect.forkScoped(store.logSetActual(input));

            // Give `applyNow` time to land before the fiber dies, matching
            // the real bug's precondition — the write is durable, only the
            // ack is lost.
            yield* Effect.sleep("50 millis");
            yield* Fiber.interrupt(firstDelivery);

            yield* store.resumeAcks;

            // The "replay": a second delivery of the SAME commandId, as the
            // outbox flusher issues after a reconnect. Before the fix this
            // hung forever awaiting the first delivery's orphaned `Deferred`.
            const replayed = yield* store.logSetActual(input).pipe(Effect.timeout("2 seconds"));

            const actuals = yield* store.listActuals;
            const matching = actuals.filter((a) => a.commandId === commandId);
            return { replayed, matching };
          }),
        );
        return outcome;
      };

      const inMemoryOutcome = await exerciseLayer(
        (effect) => effect.pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise),
        "cmd-84-in-memory",
      );
      expect(inMemoryOutcome.replayed.commandId).toBe("cmd-84-in-memory");
      expect(inMemoryOutcome.matching).toHaveLength(1);

      const sqlOutcome = await exerciseLayer(
        (effect) => runAgainstFreshLayer(dbPath, effect),
        "cmd-84-sql",
      );
      expect(sqlOutcome.replayed.commandId).toBe("cmd-84-sql");
      expect(sqlOutcome.matching).toHaveLength(1);
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
