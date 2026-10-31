import { describe, expect, it } from "vitest";

import {
  BlockId,
  CommandId,
  EntryId,
  ExerciseId,
  LoggedSessionId,
  SessionId,
  SetId,
} from "@repcoach/contracts";

import {
  buildQueuedCommand,
  decodeQueuedCommand,
  encodeQueuedCommand,
  OUTBOX_SCHEMA_VERSION,
} from "./model.ts";

const sampleSetActual = () =>
  buildQueuedCommand(
    {
      kind: "logSetActual",
      commandId: CommandId.make("cmd-1"),
      loggedSessionId: LoggedSessionId.make("logged-session-1"),
      sessionId: SessionId.make("session-seed-1"),
      entryId: EntryId.make("entry-1"),
      setId: SetId.make("set-1"),
      setType: "working",
      actual: { reps: 5, load: 100 },
    },
    1,
    "2026-07-11T00:00:00.000Z",
  );

const samplePlanEdit = () =>
  buildQueuedCommand(
    {
      kind: "applyPlanEdit",
      commandId: CommandId.make("cmd-plan-1"),
      operation: {
        _tag: "addEntry",
        sessionId: SessionId.make("session-seed-1"),
        blockId: BlockId.make("block-1"),
        entryId: EntryId.make("entry-new-1"),
        exerciseId: ExerciseId.make("exercise-1"),
      },
    },
    2,
    "2026-07-11T00:00:01.000Z",
  );

const sampleAddEntryNote = () =>
  buildQueuedCommand(
    {
      kind: "addEntryNote",
      commandId: CommandId.make("cmd-note-1"),
      loggedSessionId: LoggedSessionId.make("logged-session-1"),
      entryId: EntryId.make("entry-1"),
      text: "left elbow twinged on set 3",
      recordedAt: "2026-08-19T00:00:00.000Z",
    },
    3,
    "2026-08-19T00:00:01.000Z",
  );

const sampleEditEntryNote = () =>
  buildQueuedCommand(
    {
      kind: "editEntryNote",
      commandId: CommandId.make("cmd-note-edit-1"),
      loggedSessionId: LoggedSessionId.make("logged-session-1"),
      entryId: EntryId.make("entry-1"),
      // The note's id is the ORIGINAL add's commandId (migration `018`) — not
      // this command's own, which is why the two fields are both here.
      noteId: "cmd-note-1",
      text: "left elbow twinged, fine after the warmup",
    },
    6,
    "2026-08-25T00:00:01.000Z",
  );

const sampleSwapExercise = () =>
  buildQueuedCommand(
    {
      kind: "swapExercise",
      commandId: CommandId.make("cmd-swap-1"),
      loggedSessionId: LoggedSessionId.make("logged-session-1"),
      entryId: EntryId.make("entry-1"),
      exerciseId: ExerciseId.make("exercise-2"),
    },
    4,
    "2026-07-11T00:00:02.000Z",
  );

const sampleUnlogSetActual = () =>
  buildQueuedCommand(
    {
      kind: "unlogSetActual",
      commandId: CommandId.make("cmd-unlog-1"),
      loggedSessionId: LoggedSessionId.make("logged-session-1"),
      entryId: EntryId.make("entry-1"),
      setId: SetId.make("set-1"),
    },
    5,
    "2026-08-23T00:00:00.000Z",
  );

describe("outbox model", () => {
  it("round-trips a logSetActual command, stamping the current schema version", () => {
    const item = sampleSetActual();
    const encoded = encodeQueuedCommand(item) as Record<string, unknown>;
    expect(encoded["schemaVersion"]).toBe(OUTBOX_SCHEMA_VERSION);
    expect(decodeQueuedCommand(encoded)).toEqual(item);
  });

  /**
   * The whole point of #80: a Plan edit is a queued command like any other, so
   * it has to survive the same persist/reload cycle a logged Set does. If the
   * `PlanOperation` did not round-trip, an edit made offline would be dropped
   * on reload — exactly the loss the ticket exists to prevent.
   */
  it("round-trips an applyPlanEdit command, preserving the operation", () => {
    const item = samplePlanEdit();
    const encoded = encodeQueuedCommand(item) as Record<string, unknown>;
    expect(encoded["schemaVersion"]).toBe(OUTBOX_SCHEMA_VERSION);
    expect(decodeQueuedCommand(encoded)).toEqual(item);
  });

  /**
   * Issue #130 — "Add a note" is not a Set, so it could not reuse
   * `logSetActual` the way #129's continuations did (drop/rest-pause/
   * myo-cluster are still Sets under the hood). It needs its own round trip
   * exactly like `applyPlanEdit` got when #80 generalised the outbox.
   */
  it("round-trips an addEntryNote command", () => {
    const item = sampleAddEntryNote();
    const encoded = encodeQueuedCommand(item) as Record<string, unknown>;
    expect(encoded["schemaVersion"]).toBe(OUTBOX_SCHEMA_VERSION);
    expect(decodeQueuedCommand(encoded)).toEqual(item);
  });

  /**
   * v6 (#131, ADR 0019): a swap is a fourth queued kind, following exactly
   * the recipe `applyPlanEdit` set in #80 — its own arm, its own round trip,
   * its own place in the `kind` union.
   */
  it("round-trips a swapExercise command, preserving entryId/exerciseId", () => {
    const item = sampleSwapExercise();
    const encoded = encodeQueuedCommand(item) as Record<string, unknown>;
    expect(encoded["schemaVersion"]).toBe(OUTBOX_SCHEMA_VERSION);
    expect(decodeQueuedCommand(encoded)).toEqual(item);
  });

  /**
   * v7 (#83, ADR 0019): a retraction is a fifth queued kind, no metric map,
   * following the same recipe as every prior kind's round trip.
   */
  it("round-trips an unlogSetActual command, preserving entryId/setId, no metric map", () => {
    const item = sampleUnlogSetActual();
    const encoded = encodeQueuedCommand(item) as Record<string, unknown>;
    expect(encoded["schemaVersion"]).toBe(OUTBOX_SCHEMA_VERSION);
    expect(encoded).not.toHaveProperty("actual");
    expect(decodeQueuedCommand(encoded)).toEqual(item);
  });

  /**
   * v8 (UAT): a note rewrite is a sixth queued kind. It exists BECAUSE
   * re-sending `addEntryNote` under the note's id cannot work — the server's
   * add is `ON CONFLICT(id) DO NOTHING` — so the round trip has to keep
   * `noteId` and `commandId` distinct: collapsing them would turn every edit
   * into that no-op.
   */
  it("round-trips an editEntryNote command, keeping noteId distinct from commandId", () => {
    const item = sampleEditEntryNote();
    const encoded = encodeQueuedCommand(item) as Record<string, unknown>;
    expect(encoded["schemaVersion"]).toBe(OUTBOX_SCHEMA_VERSION);
    expect(encoded["noteId"]).not.toBe(encoded["commandId"]);
    expect(decodeQueuedCommand(encoded)).toEqual(item);
  });

  it("keeps the six kinds distinguishable after a round trip", () => {
    expect(decodeQueuedCommand(encodeQueuedCommand(sampleSetActual())).kind).toBe("logSetActual");
    expect(decodeQueuedCommand(encodeQueuedCommand(samplePlanEdit())).kind).toBe("applyPlanEdit");
    expect(decodeQueuedCommand(encodeQueuedCommand(sampleAddEntryNote())).kind).toBe("addEntryNote");
    expect(decodeQueuedCommand(encodeQueuedCommand(sampleSwapExercise())).kind).toBe("swapExercise");
    expect(decodeQueuedCommand(encodeQueuedCommand(sampleUnlogSetActual())).kind).toBe("unlogSetActual");
    expect(decodeQueuedCommand(encodeQueuedCommand(sampleEditEntryNote())).kind).toBe("editEntryNote");
  });

  /**
   * A row persisted under an older version must keep decoding once
   * `OUTBOX_SCHEMA_VERSION` moves on — the whole reason those arms list their
   * legacy versions explicitly rather than referencing the constant.
   */
  it("still decodes v4-, v5-, v6- and v7-persisted rows now that the current version is v8", () => {
    const setActualV4 = { ...(encodeQueuedCommand(sampleSetActual()) as Record<string, unknown>), schemaVersion: 4 };
    expect(decodeQueuedCommand(setActualV4)).toEqual(sampleSetActual());
    const planEditV4 = { ...(encodeQueuedCommand(samplePlanEdit()) as Record<string, unknown>), schemaVersion: 4 };
    expect(decodeQueuedCommand(planEditV4)).toEqual(samplePlanEdit());
    const noteV5 = { ...(encodeQueuedCommand(sampleAddEntryNote()) as Record<string, unknown>), schemaVersion: 5 };
    expect(decodeQueuedCommand(noteV5)).toEqual(sampleAddEntryNote());
    const swapV6 = { ...(encodeQueuedCommand(sampleSwapExercise()) as Record<string, unknown>), schemaVersion: 6 };
    expect(decodeQueuedCommand(swapV6)).toEqual(sampleSwapExercise());
    // v7 is where `unlogSetActual` first appeared, and the version the app
    // shipped before this change — a queue persisted mid-workout under it
    // must survive the upgrade with the retraction still in it.
    const unlogV7 = { ...(encodeQueuedCommand(sampleUnlogSetActual()) as Record<string, unknown>), schemaVersion: 7 };
    expect(decodeQueuedCommand(unlogV7)).toEqual(sampleUnlogSetActual());
  });

  /**
   * A v3 row predates the `kind` discriminator entirely, and every v3 row was
   * a logged Set — that is what the outbox could hold. So the absence of
   * `kind` is not ambiguous and must NOT drop the row: someone's set is
   * sitting in it.
   */
  it("migrates a v3 persisted row (no `kind`, no `seq`) as a logSetActual command", () => {
    const item = sampleSetActual();
    const {
      kind: _kind,
      seq: _seq,
      ...v3Row
    } = encodeQueuedCommand(item) as Record<string, unknown>;
    // Everything survives except `seq`, which no v3 row ever wrote — legacy
    // rows sort ahead of anything enqueued since (see `withLegacyDefaults`).
    expect(decodeQueuedCommand({ ...v3Row, schemaVersion: 3 })).toEqual({ ...item, seq: 0 });
  });

  it("migrates a legacy (v1, pre-schemaVersion-stamp) persisted row", () => {
    const item = sampleSetActual();
    // v1 rows never had `schemaVersion` — nor `kind`, nor `seq` — written at all.
    const {
      schemaVersion: _ignored,
      kind: _kind,
      seq: _seq,
      ...legacyRow
    } = encodeQueuedCommand(item) as Record<string, unknown>;
    expect(decodeQueuedCommand(legacyRow)).toEqual({ ...item, seq: 0 });
  });

  it("rejects an unknown/future schema version rather than silently misreading it", () => {
    const encoded = encodeQueuedCommand(sampleSetActual()) as Record<string, unknown>;
    expect(() => decodeQueuedCommand({ ...encoded, schemaVersion: 99 })).toThrow();
  });

  it("rejects a row whose operation is not a known PlanOperation", () => {
    const encoded = encodeQueuedCommand(samplePlanEdit()) as Record<string, unknown>;
    expect(() =>
      decodeQueuedCommand({ ...encoded, operation: { _tag: "notAnOperation" } }),
    ).toThrow();
  });
});
