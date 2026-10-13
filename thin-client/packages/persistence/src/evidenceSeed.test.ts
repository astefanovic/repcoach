import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { describe, expect, it } from "vitest";

import { loadVettedEvidenceSeed } from "./evidenceSeed.ts";
import { migrationEntries } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { SqlStore } from "./sqlStore.ts";
import { seedEvidenceRoster, Store } from "./store.ts";

/**
 * Issue #87 — the roster injected into every Deliberation run is the SEVEN
 * vetted entries of `docs/evidence/evidence-base-seed.json`, not the two
 * placeholders that shipped with issue #34's storage work.
 *
 * The tests read the seed document themselves rather than hardcoding its
 * contents: the acceptance criterion is precisely that the document is the
 * single source of truth, so an assertion that retyped the claims would be the
 * very drift it is meant to forbid. What is pinned by literal here is only what
 * the document is NOT allowed to be — no placeholder text, nothing below
 * `corpus-verified`, nothing dropped on the way to the store.
 */

const seedDocument = JSON.parse(
  fs.readFileSync(new URL("../../../../docs/evidence/evidence-base-seed.json", import.meta.url), "utf8"),
) as {
  readonly entries: ReadonlyArray<{
    readonly id: string;
    readonly claim: string;
    readonly applicability: string;
    readonly source: { readonly citation: string; readonly url?: string };
  }>;
};

const tempDbPath = (): string => path.join(os.tmpdir(), `repcoach-evidence-seed-${randomUUID()}.sqlite`);

const cleanupDbFile = (dbPath: string): void => {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
};

const rosterFromFreshLayer = (dbPath: string) =>
  Effect.gen(function* () {
    const store = yield* Store;
    return yield* store.listEvidenceRoster;
  }).pipe(Effect.provide(SqlStore.layer({ filename: dbPath })), Effect.scoped, Effect.runPromise);

describe("Vetted Evidence-base seed (#87)", () => {
  it("loads all seven vetted entries, in document order, with the document's own claims and applicability", () => {
    const roster = loadVettedEvidenceSeed();

    expect(roster).toHaveLength(7);
    expect(roster.map((e) => e.id)).toEqual(seedDocument.entries.map((e) => `evidence-seed-${e.id}`));
    expect(roster.map((e) => e.claim)).toEqual(seedDocument.entries.map((e) => e.claim));
    expect(roster.map((e) => e.applicability)).toEqual(seedDocument.entries.map((e) => e.applicability));
  });

  it("carries each entry's real citation and URL in the flattened source line", () => {
    const roster = loadVettedEvidenceSeed();

    for (const [index, entry] of roster.entries()) {
      const documented = seedDocument.entries[index]!;
      expect(entry.source).toContain(documented.source.citation);
      if (documented.source.url !== undefined) expect(entry.source).toContain(documented.source.url);
    }
  });

  it("has no placeholder text anywhere in the roster — the fake corpus-verified sources are gone", () => {
    for (const entry of loadVettedEvidenceSeed()) {
      expect(entry.source).not.toContain("PLACEHOLDER");
      expect(entry.claim).not.toContain("PLACEHOLDER");
      expect(entry.applicability).not.toContain("PLACEHOLDER");
      expect(entry.trust).toBe("corpus-verified");
    }
  });

  it("keeps E5's superseded prior position and its DO-NOT-CITE warning — the vetting's most useful output", () => {
    const e5 = loadVettedEvidenceSeed().find((entry) => entry.id === "evidence-seed-E5");

    expect(e5?.source).toContain("DO NOT CITE AS SUPPORT");
    expect(e5?.source).toContain("Effects of Resistance Training Frequency");
  });

  it("is the same list both Store layers seed — one source of truth, no in-memory/SQLite drift", async () => {
    const dbPath = tempDbPath();
    try {
      const sqlRoster = await rosterFromFreshLayer(dbPath);
      const memoryRoster = await Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.listEvidenceRoster;
      }).pipe(Effect.provide(Store.layer), Effect.scoped, Effect.runPromise);

      const expected = seedEvidenceRoster().map(({ id: _id, ...claim }) => claim);
      expect(sqlRoster).toEqual(expected);
      expect(memoryRoster).toEqual(expected);
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});

describe("Migration 010 — an existing DB carrying the placeholder rows (#87)", () => {
  /**
   * Builds a database as it existed BEFORE this issue: migrated only through
   * `008`, seeded with a Plan row (so `SqlStore`'s "is this DB empty" seeding
   * guard treats it as already-seeded) and the two placeholder evidence rows,
   * verbatim as `seedEvidenceRoster` used to emit them.
   */
  const makeLegacyDb = (dbPath: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries
              .filter(([id]) => id <= 8)
              .map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
      });

      yield* sql`INSERT INTO plan (id, plan_model, created_at) VALUES ('plan-1', 'linear-progression', '2026-07-01T00:00:00.000Z')`;
      for (const id of ["evidence-seed-1", "evidence-seed-2"]) {
        yield* sql`
          INSERT INTO evidence_claim (id, claim, source, applicability, trust, created_at)
          VALUES (
            ${id}, 'Progressive overload is necessary for continued hypertrophy adaptation.',
            'PLACEHOLDER — authoring the real ~4-6 entry seed corpus is a follow-up content task (ADR 0003 §1).',
            'General resistance training.', 'corpus-verified', '2026-07-01T00:00:00.000Z'
          )
        `;
      }
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({ filename: dbPath }).pipe(
          Layer.provide([NodeFileSystem.layer, NodePath.layer]),
        ),
      ),
      Effect.scoped,
      Effect.runPromise,
    );

  it("replaces the placeholder rows with the vetted roster on reopen — no fake source survives", async () => {
    const dbPath = tempDbPath();
    try {
      await makeLegacyDb(dbPath);

      const roster = await rosterFromFreshLayer(dbPath);

      expect(roster).toHaveLength(7);
      for (const entry of roster) expect(entry.source).not.toContain("PLACEHOLDER");
      expect(roster).toEqual(seedEvidenceRoster().map(({ id: _id, ...claim }) => claim));
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("does not re-run on the next reopen, and leaves exactly one copy of each entry", async () => {
    const dbPath = tempDbPath();
    try {
      await makeLegacyDb(dbPath);
      await rosterFromFreshLayer(dbPath);
      const roster = await rosterFromFreshLayer(dbPath);

      expect(roster).toHaveLength(7);
      expect(new Set(roster.map((e) => e.claim)).size).toBe(7);
    } finally {
      cleanupDbFile(dbPath);
    }
  });

  it("leaves a fresh DB to the ordinary seeding path — the two writers never both fire", async () => {
    const dbPath = tempDbPath();
    try {
      const roster = await rosterFromFreshLayer(dbPath);
      expect(roster).toHaveLength(7);
    } finally {
      cleanupDbFile(dbPath);
    }
  });
});
