// ONE-OFF (2026-09-24): links the owner's existing Exercise catalog rows to
// their Exercise library equivalents, so exercises in use before the library
// existed get animations too.
//
//   node scripts/link-exercise-library-once.mjs [db-path] [--apply]
//
// Dry run unless `--apply`. Needs a Node with `node:sqlite` (system Node 26).
//
// Only `library_id` is written. Ids are untouched, so the Plan, every Logged
// Session snapshot, swaps and Decision records keep pointing at the same rows
// and history needs no rewrite; names and the coach's enrichment are untouched
// too. A row is linked only while it is unlinked and still carries the name
// this mapping was written against — a row renamed since, or already linked,
// is reported and skipped.
//
// Requires migration 022 (`library_id`), which the server applies when it
// first starts on code that has it. Run this AFTER that restart — applying
// the migration out-of-band would record `22_ExerciseLibraryLink` on a
// database that master may later hand a different migration 22.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** [exerciseId, name it had when mapped, libraryId | null (no equivalent)] */
const MAPPING = [
  ["exercise-f263878d-4531-42e1-87df-4520dccfc50a", "Cable Curl", "0868"],
  ["exercise-cable-face-pull", "Cable Face Pull", null],
  ["exercise-cable-fly", "Cable Fly", "0227"],
  ["exercise-cable-lateral-raise", "Cable Lateral Raise", "0178"],
  ["exercise-cable-rear-delt-fly", "Cable Rear-Delt Fly", "0225"],
  ["exercise-cable-triceps-pushdown", "Cable Triceps Pushdown", "0241"],
  ["exercise-chest-supported-row", "Chest-Supported Machine Row", "0588"],
  ["exercise-a5d7af3a-9397-42d0-bc28-4aa0b0b65ce9", "Dragon flag", null],
  ["exercise-db-lateral-raise", "Dumbbell Lateral Raise", "0334"],
  ["exercise-ez-bar-curl", "EZ-Bar Curl", "0447"],
  ["exercise-81088f60-7cc4-40da-9859-eb3e82e5a6a6", "Hack squat", "0743"],
  ["exercise-hammer-curl", "Hammer Curl", "0313"],
  ["exercise-incline-db-curl", "Incline Dumbbell Curl", "0318"],
  ["exercise-incline-db-press", "Incline Dumbbell Press", "0314"],
  ["exercise-lat-pulldown", "Lat Pulldown", "0150"],
  ["exercise-leg-press", "Leg Press", "0739"],
  ["exercise-41ed42c9-6d37-44dd-976f-4a988ff6adc4", "Lying leg curl", "0586"],
  ["exercise-machine-chest-press", "Machine Chest Press", "0577"],
  ["exercise-machine-shoulder-press", "Machine Shoulder Press", "0603"],
  ["exercise-overhead-cable-triceps-extension", "Overhead Cable Triceps Extension", "0194"],
  ["exercise-809cfa25-5c66-4d7a-9aca-418f0cf7dfcf", "Preacher Curl", "0070"],
  ["exercise-romanian-deadlift", "Romanian Deadlift", "0085"],
  ["exercise-rope-triceps-pushdown", "Rope Triceps Pushdown", "0200"],
  ["exercise-cable-row", "Seated Cable Row", "0861"],
  ["exercise-seated-leg-curl", "Seated Leg Curl", "0599"],
  ["exercise-standing-calf-raise", "Standing Calf Raise", "0605"],
];

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dbPath = args.find((arg) => !arg.startsWith("--")) ?? join(homedir(), ".repcoach", "repcoach.sqlite");

const library = new Map(
  JSON.parse(readFileSync(new URL("../apps/web/src/exerciseLibrary/library.json", import.meta.url), "utf8")).exercises.map(
    (exercise) => [exercise.id, exercise.name],
  ),
);
for (const [, name, libraryId] of MAPPING) {
  if (libraryId !== null && !library.has(libraryId)) throw new Error(`${name}: library id ${libraryId} does not exist`);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");

const columns = db.prepare("PRAGMA table_info(exercise_catalog)").all().map((column) => column.name);
if (!columns.includes("library_id")) {
  console.error(
    `${dbPath} has no exercise_catalog.library_id yet — start the server once on code with migration 022, then rerun.`,
  );
  process.exit(1);
}

const read = db.prepare("SELECT name, library_id FROM exercise_catalog WHERE id = ?");
const link = db.prepare("UPDATE exercise_catalog SET library_id = ? WHERE id = ? AND name = ? AND library_id IS NULL");

const plan = MAPPING.map(([id, name, libraryId]) => {
  const row = read.get(id);
  if (libraryId === null) return { name, outcome: "no equivalent — left unlinked" };
  if (row === undefined) return { name, outcome: "SKIP: no such row" };
  if (row.name !== name) return { name, outcome: `SKIP: renamed since to "${row.name}"` };
  if (row.library_id !== null) return { name, outcome: `SKIP: already linked to ${row.library_id}` };
  return { id, name, libraryId, outcome: `link → ${library.get(libraryId)} [${libraryId}]` };
});
console.table(plan.map(({ name, outcome }) => ({ name, outcome })));

const toLink = plan.filter((entry) => entry.libraryId !== undefined);
if (!apply) {
  console.log(`Dry run: ${toLink.length} rows would be linked. Rerun with --apply to write.`);
  process.exit(0);
}

// A consistent copy, next to the database, before the first write.
// Local time, matching the `repcoach-backup-YYYYMMDD-HHMMSS` files already there.
const now = new Date();
const pad = (value) => String(value).padStart(2, "0");
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const backup = join(dirname(dbPath), `repcoach-backup-${stamp}-before-library-link.sqlite`);
db.prepare("VACUUM INTO ?").run(backup);
console.log(`Backup: ${backup}`);

db.exec("BEGIN IMMEDIATE");
try {
  let linked = 0;
  for (const { id, name, libraryId } of toLink) linked += Number(link.run(libraryId, id, name).changes);
  db.exec("COMMIT");
  console.log(`Linked ${linked} of ${toLink.length}.`);
} catch (cause) {
  db.exec("ROLLBACK");
  throw cause;
}
