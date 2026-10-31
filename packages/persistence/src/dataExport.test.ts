import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import type { LogSetActualInput } from "@repcoach/contracts";

import { SqlStore } from "./sqlStore.ts";
import { SEEDED_SESSION_ID, Store } from "./store.ts";

/** "Export my data": the whole database as one JSON document. */
describe("exportData", () => {
  const logOne = Effect.gen(function* () {
    const store = yield* Store;
    const { loggedSessionId } = yield* store.startSession(SEEDED_SESSION_ID as never);
    yield* store.logSetActual({
      commandId: "export-cmd-1",
      loggedSessionId,
      sessionId: SEEDED_SESSION_ID,
      entryId: "entry-1",
      setId: "set-1",
      setType: "working",
      actual: { reps: 5, load: 100 },
    } as unknown as LogSetActualInput);
    return { loggedSessionId, exported: yield* store.exportData };
  });

  it("SqlStore: dumps every table, with *_json columns inlined as JSON", async () => {
    const dbPath = path.join(os.tmpdir(), `repcoach-export-${randomUUID()}.sqlite`);
    try {
      const { loggedSessionId, exported } = await logOne.pipe(
        Effect.provide(SqlStore.layer({ filename: dbPath })),
        Effect.scoped,
        Effect.runPromise,
      );
      expect(exported.format).toBe("repcoach-export");
      expect(exported.version).toBe(1);
      expect(Object.keys(exported.tables)).toEqual(expect.arrayContaining(["logged_session", "logged_set_actual", "plan"]));
      expect(Object.keys(exported.tables).some((name) => name.startsWith("sqlite_"))).toBe(false);

      const session = exported.tables["logged_session"]?.find((row) => row["id"] === loggedSessionId);
      // The snapshot is an object, not an escaped string.
      expect(typeof session?.["snapshot_json"]).toBe("object");

      const actual = exported.tables["logged_set_actual"]?.find((row) => row["command_id"] === "export-cmd-1");
      expect(actual?.["actual_json"]).toEqual({ reps: 5, load: 100 });
      // The export survives a JSON round trip — it is what the client downloads.
      expect(JSON.parse(JSON.stringify(exported))).toEqual(exported);
    } finally {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("in-memory Store: dumps its collections under the table names they stand in for", async () => {
    const { exported } = await logOne.pipe(Effect.provide(Store.layer), Effect.runPromise);
    expect(exported.tables["logged_session"]).toHaveLength(1);
    expect(exported.tables["logged_set_actual"]).toHaveLength(1);
  });
});
