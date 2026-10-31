import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

/**
 * SqlClient layer wiring (Step 2A / task 2A.1) — mirrors t3code
 * `apps/server/src/persistence/Layers/Sqlite.ts`, with the bun branch
 * dropped (this project is Node-only per the Step 2A plan): `node:sqlite`
 * via `NodeSqliteClient`, `PRAGMA journal_mode=WAL`, `PRAGMA
 * foreign_keys=ON`, then `runMigrations()`.
 */
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runMigrations();
  }),
);

/**
 * Builds a fully-migrated `SqlClient` layer over a `node:sqlite` database
 * file (or `:memory:`). Ensures the parent directory exists for file-backed
 * databases (a fresh temp path, or a configured production DB path, may not
 * have its directory created yet).
 */
export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  if (dbPath !== ":memory:") {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  }

  return Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: { "db.name": dbPath, "service.name": "repcoach-persistence" },
    }),
  );
}, Layer.unwrap);
