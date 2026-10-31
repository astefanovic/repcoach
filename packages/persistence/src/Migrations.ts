import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./migrations/001_InitialSchema.ts";
import Migration0002 from "./migrations/002_LoggedSessionSnapshot.ts";
import Migration0003 from "./migrations/003_CoachingInputs.ts";
import Migration0004 from "./migrations/004_CadenceModelSettings.ts";
import Migration0005 from "./migrations/005_ProposalLineage.ts";
import Migration0006 from "./migrations/006_IntakeMarker.ts";
import Migration0007 from "./migrations/007_ReviseProse.ts";
import Migration0008 from "./migrations/008_DecisionWorking.ts";
import Migration0009 from "./migrations/009_ProposedPlanOperations.ts";
import Migration0010 from "./migrations/010_VettedEvidenceSeed.ts";
import Migration0011 from "./migrations/011_CycleReviewSchedule.ts";
import Migration0012 from "./migrations/012_RunLedger.ts";
import Migration0013 from "./migrations/013_RpeCaptureSetting.ts";
import Migration0014 from "./migrations/014_CadenceModelEffort.ts";
import Migration0015 from "./migrations/015_ProposedCatalogExercises.ts";
import Migration0016 from "./migrations/016_LoggedSessionFinishedAt.ts";
import Migration0017 from "./migrations/017_LoggedSessionReviewStatus.ts";
import Migration0018 from "./migrations/018_ContextNoteEntryAnchor.ts";
import Migration0019 from "./migrations/019_LoggedEntrySwap.ts";
import Migration0020 from "./migrations/020_DeliberationRunRecord.ts";
import Migration0021 from "./migrations/021_LoggedSetActualRetraction.ts";
import Migration0022 from "./migrations/022_ExerciseLibraryLink.ts";
import Migration0023 from "./migrations/023_LoggedSetNetView.ts";
import Migration0024 from "./migrations/024_LoggedSetNetSetGroupsAndSwaps.ts";
import Migration0025 from "./migrations/025_BodyweightEntry.ts";

/**
 * Migration runner (Step 2A / task 2A.1) — mirrors t3code
 * `apps/server/src/persistence/Migrations.ts`'s `Migrator.fromRecord` +
 * statically-imported-migrations shape. All migrations are statically
 * imported (no dynamic filesystem loading), so the schema is known at build
 * time and runs automatically whenever the persistence layer is built.
 *
 * Key format: "{id}_{name}" — `id` (numeric) determines execution order,
 * `name` is descriptive. `Migrator.fromRecord` parses this and returns
 * migrations sorted by id.
 */
export const migrationEntries = [
  [1, "InitialSchema", Migration0001],
  [2, "LoggedSessionSnapshot", Migration0002],
  [3, "CoachingInputs", Migration0003],
  [4, "CadenceModelSettings", Migration0004],
  [5, "ProposalLineage", Migration0005],
  [6, "IntakeMarker", Migration0006],
  [7, "ReviseProse", Migration0007],
  [8, "DecisionWorking", Migration0008],
  [9, "ProposedPlanOperations", Migration0009],
  [10, "VettedEvidenceSeed", Migration0010],
  [11, "CycleReviewSchedule", Migration0011],
  [12, "RunLedger", Migration0012],
  [13, "RpeCaptureSetting", Migration0013],
  [14, "CadenceModelEffort", Migration0014],
  [15, "ProposedCatalogExercises", Migration0015],
  [16, "LoggedSessionFinishedAt", Migration0016],
  [17, "LoggedSessionReviewStatus", Migration0017],
  [18, "ContextNoteEntryAnchor", Migration0018],
  [19, "LoggedEntrySwap", Migration0019],
  [20, "DeliberationRunRecord", Migration0020],
  [21, "LoggedSetActualRetraction", Migration0021],
  [22, "ExerciseLibraryLink", Migration0022],
  [23, "LoggedSetNetView", Migration0023],
  [24, "LoggedSetNetSetGroupsAndSwaps", Migration0024],
  [25, "BodyweightEntry", Migration0025],
] as const;

export const makeMigrationLoader = () =>
  Migrator.fromRecord(
    Object.fromEntries(migrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
  );

const run = Migrator.make({});

/**
 * Run all pending migrations. Creates the migration-tracking table if it
 * doesn't exist, then runs any migrations with id greater than the latest
 * recorded one. Returns the `[id, name]` tuples that were actually executed.
 */
export const runMigrations = Effect.fn("runMigrations")(function* () {
  yield* Effect.log("Running persistence migrations...");
  const executedMigrations = yield* run({ loader: makeMigrationLoader() });
  yield* Effect.log("Persistence migrations complete").pipe(
    Effect.annotateLogs({ migrations: executedMigrations.map(([id, name]) => `${id}_${name}`) }),
  );
  return executedMigrations;
});

/** Layer form: runs migrations as a side effect when built. */
export const MigrationsLive = Layer.effectDiscard(runMigrations());
