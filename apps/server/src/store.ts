/**
 * `Store` moved to `@repcoach/persistence` (Step 2A, task 2A.1) — this
 * module now just re-exports it so nothing else in the tree (`rpcHandlers.
 * ts`, `testControl.ts`, every test importing `./store.ts`) has to change
 * its imports. See `@repcoach/persistence`'s `store.ts` for the `Store` tag
 * + in-memory `Store.layer` + seed data, and `sqlStore.ts` for the
 * SQLite-backed `SqlStore` layer `server.ts` provides instead.
 *
 * Deliberately imports the `./store` subpath, NOT the package's root `.`
 * export: the root barrel (`index.ts`) also re-exports `SqlStore`, which
 * transitively imports `NodeSqliteClient.ts`. That module resolves
 * `node:sqlite` (via `createRequire`) at MODULE-LOAD time, which throws on
 * any Node lacking the `node:sqlite` builtin (see `NodeSqliteClient.ts`),
 * and would break every consumer of the in-memory `Store` too (e.g.
 * `rpcHandlers.test.ts`, which never touches SQL at all) — not just real
 * `SqlStore` usage. The subpath keeps "just the `Store` tag + in-memory
 * layer" decoupled from the SQLite driver at import time.
 */
export { Store, SEEDED_SESSION_ID } from "@repcoach/persistence/store";
