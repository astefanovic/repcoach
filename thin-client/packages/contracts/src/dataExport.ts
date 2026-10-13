import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/**
 * "Export my data" — everything the home server holds, as one JSON document.
 *
 * For a self-hosted app this is how a user can trust the data is theirs: the
 * whole database, readable without RepCoach, at any time. So it is a dump,
 * not a curated report — every table, every row, the coach's Decisions and
 * the run ledger included — with only one courtesy: a `*_json` column whose
 * text parses is inlined as the JSON it holds, so a Logged Session's snapshot
 * reads as an object rather than as an escaped string.
 *
 * Read-only and total: no error channel, same as `listSessions` — an empty
 * database is a valid export.
 */
export const ExportDataResult = Schema.Struct({
  format: Schema.Literal("repcoach-export"),
  /** Bumped if this document's own shape changes; the table shapes follow the server's migrations. */
  version: Schema.Literal(1),
  exportedAt: IsoDateTime,
  /** Table name → its rows, each row a column → value record. */
  tables: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
export type ExportDataResult = typeof ExportDataResult.Type;
