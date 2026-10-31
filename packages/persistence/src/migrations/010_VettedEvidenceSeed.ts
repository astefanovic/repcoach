import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { loadVettedEvidenceSeed } from "../evidenceSeed.ts";

/**
 * Issue #87 — reseat the Evidence-base roster on an **already-seeded**
 * database.
 *
 * Migration 003 created `evidence_claim`; `SqlStore`'s one-shot seeding filled
 * it with two entries whose `source` field read, verbatim, "PLACEHOLDER —
 * authoring the real ~4-6 entry seed corpus is a follow-up content task" — at
 * `trust: corpus-verified`. Fixing the seed function alone only helps a fresh
 * database: the seeding guard is "does this DB have a Plan", so any existing DB
 * would keep injecting a fake source wearing the highest trust badge into every
 * Deliberation run, forever. That is exactly the row this migration exists to
 * remove.
 *
 * **Replace, not migrate.** There is no per-row mapping from the two
 * placeholders to the seven vetted entries — one is not an edit of the other —
 * and the table has no user-authored rows to preserve: ADR 0003 makes the
 * roster server-seeded, and the `Store` interface exposes no write path onto
 * it (an adversarial test asserts that). So the whole table is discarded and
 * rewritten from the vetted document.
 *
 * **Only when it is already populated.** On a fresh database this runs before
 * `SqlStore` seeds, over an empty table; inserting here would collide with that
 * seeding on the primary key. The emptiness check keeps one and exactly one
 * writer of the roster per database lifetime.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{ readonly count: number }>`SELECT COUNT(*) as count FROM evidence_claim`;
  if ((rows[0]?.count ?? 0) === 0) return;

  yield* sql`DELETE FROM evidence_claim`;

  const seededAt = new Date().toISOString();
  yield* Effect.forEach(
    loadVettedEvidenceSeed(),
    (entry) =>
      sql`
        INSERT INTO evidence_claim (id, claim, source, applicability, trust, created_at)
        VALUES (${entry.id}, ${entry.claim}, ${entry.source}, ${entry.applicability}, ${entry.trust}, ${seededAt})
      `,
    { discard: true },
  );
});
