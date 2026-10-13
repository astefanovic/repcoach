import type {
  ActualMetricMap,
  CatalogExercise,
  ExerciseId,
  ImportedWorkout,
  MetricName,
  SetType,
} from "@repcoach/contracts";

import { findExerciseByName } from "../plan/catalog.ts";
import { KG_PER_LB, type WeightUnit } from "../units/weight.ts";
import { parseCsv } from "./csv.ts";

/**
 * Workout history exported from another app, read into the shape
 * `data.importWorkouts` writes (`workoutImport.ts` in contracts).
 *
 * Two sources, told apart by their header row:
 *
 * - **Strong** — one row per Set: `Date, Workout Name, Duration, Exercise
 *   Name, Set Order, Weight, Reps, Distance, Seconds, …, RPE`. `Set Order` is
 *   a number for a working Set and `W` / `D` / `F` for warmup / drop /
 *   failure. Older exports carry `Weight Unit` / `Distance Unit` columns;
 *   newer ones put the unit in the header (`Weight (kg)`); one with neither
 *   is in whatever unit the person had set, which is the caller's
 *   `fallbackWeightUnit`.
 * - **Hevy** — one row per Set: `title, start_time, end_time,
 *   exercise_title, set_type, weight_kg | weight_lbs, reps, distance_km |
 *   distance_miles, duration_seconds, rpe`.
 *
 * Times in both are the phone's local wall-clock time with no offset, so they
 * are read as local time on this device: a 07:00 session lands on the day it
 * was done, as long as it is imported in the same timezone.
 *
 * Everything lands in the stored units: kg, metres, seconds. A row that is
 * not a Set (Strong's rest-timer rows) or records nothing (an empty Set left
 * in a template) is skipped and counted, not an error.
 */
export type ImportSource = "strong" | "hevy";

export interface ParsedSet {
  readonly setType: SetType;
  readonly actual: ActualMetricMap;
}

export interface ParsedExercise {
  readonly name: string;
  readonly trackedMetrics: ReadonlyArray<MetricName>;
  readonly sets: ReadonlyArray<ParsedSet>;
}

export interface ParsedWorkout {
  readonly importKey: string;
  readonly name: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exercises: ReadonlyArray<ParsedExercise>;
}

export interface ParsedImport {
  readonly source: ImportSource;
  /** Oldest first. */
  readonly workouts: ReadonlyArray<ParsedWorkout>;
  /** Every distinct exercise name, in first-seen order. */
  readonly exerciseNames: ReadonlyArray<string>;
  readonly setCount: number;
  /** Rows that were not a Set, or recorded nothing. */
  readonly skippedRows: number;
}

export type ParseImportResult =
  | { readonly ok: true; readonly value: ParsedImport }
  | { readonly ok: false; readonly reason: string };

export interface ParseImportOptions {
  /** The unit a Strong export with no unit column or header is in. */
  readonly fallbackWeightUnit: WeightUnit;
}

const KM_PER_MILE = 1.609344;
const METRIC_ORDER: ReadonlyArray<MetricName> = ["reps", "load", "duration", "distance", "rpe"];

export function parseWorkoutCsv(text: string, options: ParseImportOptions): ParseImportResult {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) return { ok: false, reason: "The file is empty." };
  const columns = new Map(header.map((name, index) => [name.trim().toLowerCase(), index] as const));
  const source: ImportSource | undefined = columns.has("exercise name") && columns.has("set order")
    ? "strong"
    : columns.has("exercise_title") && columns.has("start_time")
      ? "hevy"
      : undefined;
  if (source === undefined) {
    return { ok: false, reason: "This doesn't look like a Strong or Hevy export: its columns aren't ones either app writes." };
  }
  const read = source === "strong" ? strongRowReader(columns, options) : hevyRowReader(columns);

  const workouts = new Map<string, MutableWorkout>();
  const exerciseNames = new Map<string, string>();
  let setCount = 0;
  let skippedRows = 0;
  for (const cells of rows.slice(1)) {
    const row = read((name) => cells[columns.get(name) ?? -1]?.trim() ?? "");
    if (row === undefined) {
      skippedRows++;
      continue;
    }
    const importKey = `${source}|${row.startRaw}|${row.workoutName}`;
    let workout = workouts.get(importKey);
    if (workout === undefined) {
      workout = {
        importKey,
        name: row.workoutName.length > 0 ? row.workoutName : undefined,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        exercises: new Map(),
      };
      workouts.set(importKey, workout);
    }
    let sets = workout.exercises.get(row.exerciseName);
    if (sets === undefined) {
      sets = [];
      workout.exercises.set(row.exerciseName, sets);
    }
    sets.push(row.set);
    setCount++;
    if (!exerciseNames.has(row.exerciseName.toLowerCase())) {
      exerciseNames.set(row.exerciseName.toLowerCase(), row.exerciseName);
    }
  }
  if (workouts.size === 0) {
    return { ok: false, reason: "The file has the right columns but no Sets in it." };
  }
  const parsed = Array.from(workouts.values())
    .map((workout): ParsedWorkout => ({
      importKey: workout.importKey,
      name: workout.name,
      startedAt: workout.startedAt,
      finishedAt: workout.finishedAt,
      exercises: Array.from(workout.exercises, ([name, sets]) => ({
        name,
        trackedMetrics: METRIC_ORDER.filter((metric) => sets.some((set) => set.actual[metric] !== undefined)),
        sets,
      })),
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return {
    ok: true,
    value: { source, workouts: parsed, exerciseNames: Array.from(exerciseNames.values()), setCount, skippedRows },
  };
}

/**
 * The catalog row an imported name already means, if any. Both apps write
 * the equipment in parentheses (`Bench Press (Barbell)`), so the name is
 * also tried as `Barbell Bench Press` and as plain `Bench Press`.
 */
export function matchImportedExercise(
  catalog: ReadonlyArray<CatalogExercise>,
  name: string,
): CatalogExercise | undefined {
  const paren = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(name);
  const candidates = paren === null ? [name] : [name, `${paren[2]} ${paren[1]}`, paren[1]!];
  for (const candidate of candidates) {
    const match = findExerciseByName(catalog, candidate);
    if (match !== undefined) return match;
  }
  return undefined;
}

/**
 * The parsed workouts as the RPC payload, given the exercise id each name
 * was mapped to. A name with no id is dropped from its workout, and a
 * workout left with nothing is dropped altogether.
 */
export function toImportPayload(
  workouts: ReadonlyArray<ParsedWorkout>,
  exerciseIdByName: ReadonlyMap<string, ExerciseId>,
): ReadonlyArray<ImportedWorkout> {
  return workouts.flatMap((workout): ReadonlyArray<ImportedWorkout> => {
    const entries = workout.exercises.flatMap((exercise) => {
      const exerciseId = exerciseIdByName.get(exercise.name);
      return exerciseId === undefined
        ? []
        : [{ exerciseId, trackedMetrics: exercise.trackedMetrics, sets: exercise.sets }];
    });
    if (entries.length === 0) return [];
    return [
      {
        importKey: workout.importKey,
        ...(workout.name !== undefined ? { name: workout.name } : {}),
        startedAt: workout.startedAt,
        finishedAt: workout.finishedAt,
        entries,
      },
    ];
  });
}

// --- row readers ------------------------------------------------------------

interface MutableWorkout {
  readonly importKey: string;
  readonly name: string | undefined;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exercises: Map<string, Array<ParsedSet>>;
}

interface ImportRow {
  readonly startRaw: string;
  readonly workoutName: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exerciseName: string;
  readonly set: ParsedSet;
}

type Cell = (column: string) => string;
type RowReader = (cell: Cell) => ImportRow | undefined;

function strongRowReader(columns: ReadonlyMap<string, number>, options: ParseImportOptions): RowReader {
  const headerUnit = (prefix: string): string | undefined => {
    for (const name of columns.keys()) {
      const match = new RegExp(`^${prefix}\\s*\\((\\w+)\\)$`).exec(name);
      if (match !== null) return match[1];
    }
    return undefined;
  };
  const weightColumn = columns.has("weight") ? "weight" : findColumn(columns, /^weight\s*\(/);
  const distanceColumn = columns.has("distance") ? "distance" : findColumn(columns, /^distance\s*\(/);
  const weightHeaderUnit = headerUnit("weight");
  const distanceHeaderUnit = headerUnit("distance");
  return (cell) => {
    const setType = strongSetType(cell("set order"));
    const startRaw = cell("date");
    const startedAt = parseLocalDateTime(startRaw);
    const exerciseName = cell("exercise name");
    if (setType === undefined || startedAt === undefined || exerciseName.length === 0) return undefined;
    const weightUnit = cell("weight unit") || weightHeaderUnit || (options.fallbackWeightUnit === "lb" ? "lbs" : "kg");
    const distanceUnit = cell("distance unit") || distanceHeaderUnit || (options.fallbackWeightUnit === "lb" ? "mi" : "km");
    const actual = actualOf({
      reps: parseNumber(cell("reps")),
      loadKg: toKg(parseNumber(weightColumn === undefined ? "" : cell(weightColumn)), weightUnit),
      durationSec: parseNumber(cell("seconds")),
      distanceM: toMetres(parseNumber(distanceColumn === undefined ? "" : cell(distanceColumn)), distanceUnit),
      rpe: parseNumber(cell("rpe")),
    });
    if (actual === undefined) return undefined;
    const durationSec = parseStrongDuration(cell("duration"));
    return {
      startRaw,
      workoutName: cell("workout name"),
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + (durationSec ?? 0) * 1000).toISOString(),
      exerciseName,
      set: { setType, actual },
    };
  };
}

function hevyRowReader(columns: ReadonlyMap<string, number>): RowReader {
  const pounds = !columns.has("weight_kg") && columns.has("weight_lbs");
  const miles = !columns.has("distance_km") && columns.has("distance_miles");
  return (cell) => {
    const setType = hevySetType(cell("set_type"));
    const startRaw = cell("start_time");
    const startedAt = parseLocalDateTime(startRaw);
    const exerciseName = cell("exercise_title");
    if (setType === undefined || startedAt === undefined || exerciseName.length === 0) return undefined;
    const actual = actualOf({
      reps: parseNumber(cell("reps")),
      loadKg: toKg(parseNumber(cell(pounds ? "weight_lbs" : "weight_kg")), pounds ? "lbs" : "kg"),
      durationSec: parseNumber(cell("duration_seconds")),
      distanceM: toMetres(parseNumber(cell(miles ? "distance_miles" : "distance_km")), miles ? "mi" : "km"),
      rpe: parseNumber(cell("rpe")),
    });
    if (actual === undefined) return undefined;
    const finishedAt = parseLocalDateTime(cell("end_time"));
    return {
      startRaw,
      workoutName: cell("title"),
      startedAt: startedAt.toISOString(),
      finishedAt: (finishedAt !== undefined && finishedAt >= startedAt ? finishedAt : startedAt).toISOString(),
      exerciseName,
      set: { setType, actual },
    };
  };
}

function findColumn(columns: ReadonlyMap<string, number>, pattern: RegExp): string | undefined {
  for (const name of columns.keys()) if (pattern.test(name)) return name;
  return undefined;
}

function strongSetType(order: string): SetType | undefined {
  if (/^\d+$/.test(order)) return "working";
  switch (order.toUpperCase()) {
    case "W":
      return "warmup";
    case "D":
      return "drop";
    case "F":
      return "working";
    default:
      return undefined;
  }
}

function hevySetType(type: string): SetType | undefined {
  switch (type.toLowerCase()) {
    case "":
    case "normal":
    case "failure":
      return "working";
    case "warmup":
      return "warmup";
    case "dropset":
      return "drop";
    default:
      return undefined;
  }
}

/** A Set's actuals with zeros and blanks left out; `undefined` when it recorded nothing. */
function actualOf(values: {
  readonly reps: number | undefined;
  readonly loadKg: number | undefined;
  readonly durationSec: number | undefined;
  readonly distanceM: number | undefined;
  readonly rpe: number | undefined;
}): ActualMetricMap | undefined {
  const positive = (value: number | undefined) => (value !== undefined && value > 0 ? value : undefined);
  const reps = positive(values.reps);
  const load = positive(values.loadKg);
  const duration = positive(values.durationSec);
  const distance = positive(values.distanceM);
  const rpe = values.rpe !== undefined && values.rpe > 0 && values.rpe <= 10 ? values.rpe : undefined;
  if (reps === undefined && load === undefined && duration === undefined && distance === undefined) return undefined;
  return {
    ...(reps !== undefined ? { reps } : {}),
    ...(load !== undefined ? { load } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(distance !== undefined ? { distance } : {}),
    ...(rpe !== undefined ? { rpe } : {}),
  };
}

/** `62.5`, or `62,5` from a locale that writes decimal commas. */
function parseNumber(text: string): number | undefined {
  if (text.length === 0) return undefined;
  const normalized = !text.includes(".") && /^-?\d+,\d+$/.test(text) ? text.replace(",", ".") : text;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function toKg(value: number | undefined, unit: string): number | undefined {
  if (value === undefined) return undefined;
  return /^lbs?$/i.test(unit) ? round(value * KG_PER_LB, 3) : value;
}

function toMetres(value: number | undefined, unit: string): number | undefined {
  if (value === undefined) return undefined;
  if (/^(mi|miles?)$/i.test(unit)) return round(value * KM_PER_MILE * 1000, 1);
  if (/^m$/i.test(unit)) return value;
  return round(value * 1000, 1);
}

/** Strong's workout length: `1h 5m`, `45m`, `50s`, or bare seconds. */
function parseStrongDuration(text: string): number | undefined {
  if (text.length === 0) return undefined;
  if (/^\d+$/.test(text)) return Number(text);
  const part = (unit: string) => Number(new RegExp(`(\\d+)\\s*${unit}`).exec(text)?.[1] ?? 0);
  const seconds = part("h") * 3600 + part("m(?!s)") * 60 + part("s");
  return seconds > 0 ? seconds : undefined;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * `2024-01-15 09:30:00` (Strong, newer Hevy) or `15 Jan 2024, 09:30` (Hevy)
 * as local wall-clock time; a string with its own offset is taken as-is.
 */
export function parseLocalDateTime(text: string): Date | undefined {
  if (text.length === 0) return undefined;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (iso !== null) {
    return local(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), iso[4], iso[5], iso[6]);
  }
  const named = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (named !== null) {
    const month = MONTHS.indexOf(named[2]!.toLowerCase());
    if (month < 0) return undefined;
    return local(Number(named[3]), month, Number(named[1]), named[4], named[5], named[6]);
  }
  return undefined;
}

function local(
  year: number,
  month: number,
  day: number,
  hours: string | undefined,
  minutes: string | undefined,
  seconds: string | undefined,
): Date | undefined {
  const date = new Date(year, month, day, Number(hours ?? 0), Number(minutes ?? 0), Number(seconds ?? 0));
  return Number.isNaN(date.getTime()) ? undefined : date;
}
