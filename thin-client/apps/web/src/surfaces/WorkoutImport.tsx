// Importing workout history from Strong or Hevy — a CSV the other app
// exports, parsed and matched on the device (`WorkoutImport` in
// `@repcoach/client-runtime`), written by `data.importWorkouts`.
//
// Three steps on one card: choose the file, check what it found (and which of
// your exercises each name means), import. The check is the point: an import
// that silently mints forty near-duplicate exercises is worse than none, so
// every name is shown with what it will become before anything is written.
import { useMemo, useState } from "react";

import { WorkoutImport } from "@repcoach/client-runtime";
import { RPC_METHODS, type CatalogExercise, type ExerciseId } from "@repcoach/contracts";

import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { callRpc, describeFailure } from "../runtime/rpc.ts";
import { useExerciseCatalog } from "../runtime/useExerciseCatalog.ts";
import { useWeightUnit } from "../runtime/weightUnit.ts";

/** A name's choice: an existing catalog id, a new exercise, or leave it out. */
const NEW = "__new__";
const SKIP = "__skip__";

/** Workouts per `data.importWorkouts` call — years of history in one payload is a long silent wait. */
const BATCH = 25;

type Step =
  | { readonly kind: "idle" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | { readonly kind: "preview"; readonly fileName: string; readonly parsed: WorkoutImport.ParsedImport }
  | { readonly kind: "importing"; readonly done: number; readonly total: number }
  | { readonly kind: "imported"; readonly imported: number; readonly skipped: number }
  | { readonly kind: "failed"; readonly reason: string };

const SOURCE_LABEL: Record<WorkoutImport.ImportSource, string> = { strong: "Strong", hevy: "Hevy" };

export function WorkoutImportSection({ offline }: { readonly offline: boolean }) {
  const runtime = useRuntime();
  const weightUnit = useWeightUnit();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [choices, setChoices] = useState<ReadonlyMap<string, string>>(new Map());
  const catalog = useExerciseCatalog(step.kind === "preview");
  const exercises = catalog.state.status === "ready" ? catalog.state.exercises : undefined;

  const choose = (file: File) => {
    void file.text().then(
      (text) => {
        const result = WorkoutImport.parseWorkoutCsv(text, { fallbackWeightUnit: weightUnit });
        setChoices(new Map());
        setStep(
          result.ok
            ? { kind: "preview", fileName: file.name, parsed: result.value }
            : { kind: "unreadable", reason: result.reason },
        );
      },
      (cause: unknown) => setStep({ kind: "unreadable", reason: describeFailure(cause) }),
    );
  };

  // What each name maps to: the person's pick, else the catalog match, else a new exercise.
  const resolved = useMemo(() => {
    if (step.kind !== "preview" || exercises === undefined) return undefined;
    return new Map(
      step.parsed.exerciseNames.map((name) => [
        name,
        choices.get(name) ?? WorkoutImport.matchImportedExercise(exercises, name)?.id ?? NEW,
      ]),
    );
  }, [step, exercises, choices]);

  const runImport = async (parsed: WorkoutImport.ParsedImport, mapping: ReadonlyMap<string, string>) => {
    try {
      const idByName = new Map<string, ExerciseId>();
      for (const [name, choice] of mapping) {
        if (choice === SKIP) continue;
        idByName.set(name, choice === NEW ? (await catalog.create(name)).id : (choice as ExerciseId));
      }
      const workouts = WorkoutImport.toImportPayload(parsed.workouts, idByName);
      let imported = 0;
      let skipped = 0;
      setStep({ kind: "importing", done: 0, total: workouts.length });
      for (let start = 0; start < workouts.length; start += BATCH) {
        const result = await callRpc(runtime, RPC_METHODS.importWorkouts, {
          workouts: workouts.slice(start, start + BATCH),
        });
        imported += result.imported;
        skipped += result.skipped;
        setStep({ kind: "importing", done: Math.min(start + BATCH, workouts.length), total: workouts.length });
      }
      setStep({ kind: "imported", imported, skipped });
    } catch (cause) {
      setStep({ kind: "failed", reason: describeFailure(cause) });
    }
  };

  return (
    <section className="mt-6" aria-labelledby="workout-import-heading">
      <h4 id="workout-import-heading" className="text-sm font-semibold">
        Import from Strong or Hevy
      </h4>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        Bring your workout history across from the CSV either app exports. Importing the same file again skips the
        workouts already here.
      </p>

      {step.kind !== "preview" && step.kind !== "importing" && (
        <label
          className={`mt-2 inline-block rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken ${
            offline ? "pointer-events-none opacity-40" : "cursor-pointer"
          }`}
        >
          Choose a CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={offline}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) choose(file);
            }}
          />
        </label>
      )}

      {step.kind === "unreadable" && (
        <p role="alert" className="mt-1 text-xs text-danger">
          Could not read that file — {step.reason}
        </p>
      )}

      {step.kind === "preview" && (
        <ImportPreview
          fileName={step.fileName}
          parsed={step.parsed}
          catalog={exercises}
          catalogError={catalog.state.status === "failed" ? catalog.state.reason : undefined}
          resolved={resolved}
          offline={offline}
          onChoose={(name, choice) => setChoices((current) => new Map(current).set(name, choice))}
          onCancel={() => setStep({ kind: "idle" })}
          onImport={() => {
            if (resolved !== undefined) void runImport(step.parsed, resolved);
          }}
        />
      )}

      {step.kind === "importing" && (
        <p role="status" className="mt-2 text-sm">
          Importing… {step.done} of {step.total} workouts
        </p>
      )}

      {step.kind === "imported" && (
        <p role="status" className="mt-2 text-sm">
          Imported {step.imported} {step.imported === 1 ? "workout" : "workouts"}
          {step.skipped > 0 && ` · ${step.skipped} already here, skipped`}.
        </p>
      )}

      {step.kind === "failed" && (
        <p role="alert" className="mt-1 text-xs text-danger">
          Import stopped — {step.reason}. Importing the file again picks up where it left off.
        </p>
      )}
    </section>
  );
}

function ImportPreview({
  fileName,
  parsed,
  catalog,
  catalogError,
  resolved,
  offline,
  onChoose,
  onCancel,
  onImport,
}: {
  readonly fileName: string;
  readonly parsed: WorkoutImport.ParsedImport;
  readonly catalog: ReadonlyArray<CatalogExercise> | undefined;
  readonly catalogError: string | undefined;
  readonly resolved: ReadonlyMap<string, string> | undefined;
  readonly offline: boolean;
  readonly onChoose: (name: string, choice: string) => void;
  readonly onCancel: () => void;
  readonly onImport: () => void;
}) {
  const first = parsed.workouts[0]!;
  const last = parsed.workouts[parsed.workouts.length - 1]!;
  const sorted = useMemo(
    () => (catalog === undefined ? [] : [...catalog].sort((a, b) => a.name.localeCompare(b.name))),
    [catalog],
  );
  const choices = resolved === undefined ? [] : Array.from(resolved.values());
  const newCount = choices.filter((choice) => choice === NEW).length;
  const skipCount = choices.filter((choice) => choice === SKIP).length;
  const matchedCount = choices.length - newCount - skipCount;

  return (
    <div className="mt-2 rounded-control border border-border p-3">
      <p className="text-sm">
        <span className="font-semibold">{SOURCE_LABEL[parsed.source]} export</span>{" "}
        <span className="text-text-muted">({fileName})</span>
      </p>
      <p className="mt-1 text-sm">
        {parsed.workouts.length} {parsed.workouts.length === 1 ? "workout" : "workouts"} · {parsed.setCount} sets ·{" "}
        {formatDay(first.startedAt)}
        {parsed.workouts.length > 1 && ` – ${formatDay(last.startedAt)}`}
      </p>
      {parsed.skippedRows > 0 && (
        <p className="mt-1 text-xs text-text-muted">
          {parsed.skippedRows} {parsed.skippedRows === 1 ? "row isn't" : "rows aren't"} a set with anything recorded,
          and will be left out.
        </p>
      )}

      <h5 className="mt-3 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">Exercises</h5>
      {catalogError !== undefined && (
        <p role="alert" className="mt-1 text-xs text-danger">
          Could not load your exercises — {catalogError}
        </p>
      )}
      {resolved === undefined && catalogError === undefined && (
        <p className="mt-1 text-sm text-text-muted">Matching exercises…</p>
      )}
      {resolved !== undefined && (
        <>
          <p className="mt-1 text-xs text-text-muted">
            {matchedCount} {matchedCount === 1 ? "matches" : "match"} one of yours · {newCount} new
            {skipCount > 0 && ` · ${skipCount} left out`}
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {parsed.exerciseNames.map((name) => (
              <li key={name} className="flex flex-col gap-1">
                <label htmlFor={`import-${name}`} className="text-sm">
                  {name}
                </label>
                <select
                  id={`import-${name}`}
                  className="rounded border border-border-strong bg-transparent px-2 py-1 text-sm"
                  value={resolved.get(name)}
                  onChange={(event) => onChoose(name, event.target.value)}
                >
                  <option value={NEW}>Add as a new exercise</option>
                  <option value={SKIP}>Leave out</option>
                  {sorted.map((exercise) => (
                    <option key={exercise.id} value={exercise.id}>
                      {exercise.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onImport}
          disabled={offline || resolved === undefined || skipCount === choices.length}
          className="rounded-control bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-40"
        >
          Import {parsed.workouts.length} {parsed.workouts.length === 1 ? "workout" : "workouts"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
