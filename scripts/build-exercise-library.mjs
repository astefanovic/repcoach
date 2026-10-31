// Regenerates `apps/web/src/exerciseLibrary/library.json` from the upstream
// exercises dataset (hasaneyldrm/exercises-dataset), pinned to one commit so
// the ids and media paths the catalog links to never move underneath it.
//
//   node scripts/build-exercise-library.mjs [commit-sha]
//
// Only the metadata is vendored (MIT). The animations and thumbnails are
// © Gym visual and are NOT copied into this repo — the client loads them from
// the pinned upstream commit through jsDelivr (see `library.ts`).
//
// The upstream file is ~17 MB, almost all of it instructions in ten
// languages. The picker needs English only, so this keeps the English steps
// and drops everything else.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_COMMIT = "7455efae41b330c265e7cd4b78dfa848e7ce5ebd";
const commit = process.argv[2] ?? DEFAULT_COMMIT;
const source = `https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/${commit}/data/exercises.json`;
const target = fileURLToPath(new URL("../apps/web/src/exerciseLibrary/library.json", import.meta.url));

const LOWER = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with", "vs"]);
const UPPER = new Set(["ez", "pov", "v", "t", "w", "y", "i"]);

/** `barbell full squat (back pov)` → `Barbell Full Squat (Back POV)`. */
function titleCase(name) {
  return name
    .split(/(\s+|[-/()])/)
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (!/^[a-z0-9']+$/i.test(part)) return part;
      if (UPPER.has(lower)) return lower.toUpperCase();
      if (index > 0 && LOWER.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("");
}

const response = await fetch(source);
if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
const raw = await response.json();

/**
 * The shared stem of `videos/<stem>.gif` and `images/<stem>.jpg`. `library.ts`
 * rebuilds both paths from it, so a row where they disagree would show one
 * exercise's thumbnail over another's animation — refuse it here instead.
 */
function mediaStem(row) {
  const stem = /^videos\/(.+)\.gif$/.exec(row.gif_url)?.[1];
  if (stem === undefined || row.image !== `images/${stem}.jpg`) {
    throw new Error(`exercise ${row.id}: media paths ${row.gif_url} / ${row.image} do not share a stem`);
  }
  return stem;
}

const exercises = raw
  .map((row) => ({
    id: row.id,
    // Upstream mis-encodes a few degree signs as `в°` ("Sled 45в° Leg Press").
    name: titleCase(row.name.trim().replace(/в°/g, "°")),
    bodyPart: row.body_part ?? row.category,
    equipment: row.equipment,
    target: row.target,
    secondary: row.secondary_muscles ?? [],
    media: mediaStem(row),
    steps: row.instruction_steps?.en ?? [],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(target, `${JSON.stringify({ commit, exercises })}\n`);
console.log(`${exercises.length} exercises → ${target}`);
