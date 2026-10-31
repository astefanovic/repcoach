import type { CatalogExercise } from "@repcoach/contracts";

/**
 * Searching the Exercise catalog, and deciding whether the user is about to
 * mint a duplicate (#102, ADR 0016 §2).
 *
 * The picker is the *only* place duplicates are prevented. A catalog row is
 * the join key per-muscle volume is derived through, so three spellings of
 * one exercise split its volume three ways and the coach reasons over the
 * split — a failure that surfaces months later, on history already dirty.
 * ADR 0016 declines coach-side merge (rewriting the join key on historical
 * Entries is a data migration, not a metadata edit), which leaves matching at
 * type time carrying the whole job.
 *
 * Hence: match **loosely**, and put `create` **last**. Loose matching means a
 * near-miss spelling still surfaces the row that already exists, and the last
 * position means you have to visibly walk past it to make a second one.
 */

/**
 * The form two names are compared in: case-folded, accent-stripped, and with
 * every separator — spaces, hyphens, slashes, parentheses — removed.
 *
 * That collapses the spellings people actually alternate between (`Face
 * Pull` / `face-pull` / `facepull`, `Bulgarian Split-Squat` / `bulgarian
 * split squat`) onto one key, so they match as equal rather than reading as
 * two exercises.
 */
export function normalizeExerciseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Gym-floor shorthand for the equipment word it stands in for. Expanded at
 * the word level (not as a raw substring) because `db` is not a substring of
 * `dumbbell` — the letters don't run consecutively — so no amount of loosening
 * the substring check would ever bridge that pair.
 */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  db: "dumbbell",
  dbs: "dumbbell",
  bb: "barbell",
  bbs: "barbell",
  kb: "kettlebell",
  kbs: "kettlebell",
  ohp: "overheadpress",
  rdl: "romaniandeadlift",
  bw: "bodyweight",
};

/**
 * How well `name` matches what the user has typed, or `undefined` for no
 * match at all. Lower is better, so results can sort best-first with the
 * `create` row (which has no rank) falling below all of them structurally.
 *
 * Tiers, loosest last:
 *
 * 0. exact under normalization;
 * 1. the normalized name starts with the normalized query;
 * 2. the normalized query — or its whole-word abbreviation expansion, e.g.
 *    `db` to `dumbbell` — is a substring of the normalized name;
 * 3. every whitespace-separated word of the query, or that word's
 *    abbreviation expansion, appears somewhere in the name, in any order —
 *    so `incline db press` still finds `Incline Dumbbell Bench Press` and
 *    `press bench` still finds `Bench Press`.
 *
 * An empty query matches everything at the loosest tier: an unfiltered
 * picker is the catalog.
 */
export function rankExerciseMatch(name: string, query: string): number | undefined {
  const normalizedQuery = normalizeExerciseName(query);
  const normalizedName = normalizeExerciseName(name);
  if (normalizedQuery.length === 0) return 3;
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;
  if (normalizedName.includes(normalizedQuery)) return 2;
  const expandedQuery = ABBREVIATIONS[normalizedQuery];
  if (expandedQuery !== undefined && normalizedName.includes(expandedQuery)) return 2;

  const words = query.split(/\s+/).filter((word) => word.length > 0);
  const wordsMatch =
    words.length > 1 &&
    words.every((word) => {
      const normalizedWord = normalizeExerciseName(word);
      if (normalizedWord.length === 0) return true;
      if (normalizedName.includes(normalizedWord)) return true;
      const expandedWord = ABBREVIATIONS[normalizedWord];
      return expandedWord !== undefined && normalizedName.includes(expandedWord);
    });
  return wordsMatch ? 3 : undefined;
}

/**
 * Does `name` match what the user has typed so far? A convenience over
 * {@link rankExerciseMatch} for call sites that only need yes/no, not the
 * ranking — see that function for what counts as a match.
 */
export function matchesExerciseQuery(name: string, query: string): boolean {
  return rankExerciseMatch(name, query) !== undefined;
}

/**
 * The catalog row `query` names outright, if there is one — an *exact* match
 * under normalization, not merely a good one.
 *
 * This is what suppresses the `create` row: offering `create "face pull"`
 * under an existing `Face Pull` is offering to split the exercise's history
 * in two, and no wording on the row makes that a reasonable thing to tap.
 * Anything short of exact still offers creation, because `Face Pull` and
 * `Face Pull (cable)` are allowed to be two exercises if the user says so.
 */
export function findExerciseByName(
  catalog: ReadonlyArray<CatalogExercise>,
  query: string,
): CatalogExercise | undefined {
  const normalizedQuery = normalizeExerciseName(query);
  if (normalizedQuery.length === 0) return undefined;
  return catalog.find((exercise) => normalizeExerciseName(exercise.name) === normalizedQuery);
}
