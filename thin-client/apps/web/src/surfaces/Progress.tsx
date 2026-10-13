// Progress — "show movement on the proxies the coach chose for the Goal"
// (ui-surfaces.md). This first build carries the proxies every strength
// tracker carries: estimated one-rep max and working volume per lift, with
// the sessions that set a record marked, and a bodyweight trend.
//
// Its own route off Today, beside History and Stats, not a fifth dock
// destination — the same call #114 and #117 made, for the same reason (#42's
// IA stays at four).
//
// Card-less like the rest of the app: hairline rules, no panels. The line is
// neutral ink; green is spent only on records, because a record is something
// that landed (the shared colour semantics), and red stays the coach's.
//
// x is sessions, not calendar time: three weeks off is not a slope, and a
// phone-width chart of a year would put a month's sessions on one pixel.
import { useMemo, useState } from "react";

import { Stats, Units } from "@repcoach/client-runtime";
import type { CatalogExercise, ExerciseProgress } from "@repcoach/contracts";

import type { BodyweightHandle } from "../runtime/useBodyweight.ts";
import type { ExerciseProgressState } from "../runtime/useExerciseProgress.ts";
import { useWeightUnit } from "../runtime/weightUnit.ts";
import { exerciseName } from "../ui/chrome.ts";

const CHART = { width: 320, height: 120 } as const;

function Notice({ children }: { readonly children: React.ReactNode }) {
  return <p className="mt-4 text-sm leading-snug text-text-muted">{children}</p>;
}

function SectionHeading({ children }: { readonly children: React.ReactNode }) {
  return (
    <h2 className="mt-8 border-b border-border pb-1 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
      {children}
    </h2>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function Progress({
  offline,
  state,
  catalog,
  bodyweight,
}: {
  readonly offline: boolean;
  readonly state: ExerciseProgressState;
  readonly catalog: ReadonlyArray<CatalogExercise>;
  readonly bodyweight: BodyweightHandle;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-10">
      <header className="border-b border-border-strong pt-5 pb-3">
        <div className="font-numeric text-xs tracking-widest text-text-faint uppercase">Progress</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight @2xl:text-3xl">Strength and bodyweight</h1>
      </header>

      <SectionHeading>Strength</SectionHeading>

      {offline ? (
        <Notice>Not connected to home — Progress lives on the home server and can't be read from here.</Notice>
      ) : state.status === "loading" ? (
        <Notice>Loading…</Notice>
      ) : state.status === "failed" ? (
        <Notice>Could not load Progress — {state.reason}</Notice>
      ) : (
        <Strength exercises={state.exercises} catalog={catalog} />
      )}

      {!offline && <Bodyweight handle={bodyweight} />}
    </div>
  );
}

function Strength({
  exercises,
  catalog,
}: {
  readonly exercises: ReadonlyArray<ExerciseProgress>;
  readonly catalog: ReadonlyArray<CatalogExercise>;
}) {
  const chartable = useMemo(() => Stats.chartableExercises(exercises), [exercises]);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const weightUnit = useWeightUnit();

  if (chartable.length === 0) {
    return <Notice>Finish a workout and each lift's estimated one-rep max shows up here.</Notice>;
  }

  const exercise = chartable.find((candidate) => candidate.exerciseId === chosen) ?? chartable[0]!;
  const points = Stats.progressPoints(exercise);
  const best = points.reduce<Stats.ProgressPoint | undefined>(
    (top, point) => (point.e1rm !== undefined && (top?.e1rm === undefined || point.e1rm > top.e1rm) ? point : top),
    undefined,
  );
  const records = points.filter((point) => point.isPr).reverse();
  // Rounded once, in the unit shown: rounding the kg first and then
  // converting reads 135 lb back as 134.9.
  const load = (kg: number) =>
    `${Math.round((weightUnit === "kg" ? kg : kg / Units.KG_PER_LB) * 10) / 10} ${weightUnit}`;

  return (
    <section className="mt-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">Exercise</span>
        <select
          value={exercise.exerciseId}
          onChange={(event) => setChosen(event.target.value)}
          className="rounded border border-border-strong bg-transparent px-2 py-1.5 text-sm"
        >
          {chartable.map((candidate) => (
            <option key={candidate.exerciseId} value={candidate.exerciseId}>
              {exerciseName(catalog, candidate.exerciseId)}
            </option>
          ))}
        </select>
      </label>

      <p className="mt-4 text-sm leading-snug">
        {best?.e1rm === undefined ? (
          <span className="text-text-muted">No loaded sets of 1–12 reps yet, so no one-rep max to estimate.</span>
        ) : (
          <>
            Best estimated 1RM <span className="font-semibold">{load(best.e1rm)}</span>
            <span className="text-text-muted">
              {" "}
              · {best.topSet !== undefined && `${load(best.topSet.load)} × ${best.topSet.reps}`} on{" "}
              {shortDate(best.performedAt)}
            </span>
          </>
        )}
      </p>
      <p className="text-xs text-text-muted">
        {points.length} {points.length === 1 ? "session" : "sessions"} · estimate by the Epley formula
      </p>

      <LineChart
        label={`Estimated one-rep max for ${exerciseName(catalog, exercise.exerciseId)}, one point per session.`}
        values={points.map((point) =>
          point.e1rm === undefined ? undefined : Units.kgToDisplay(point.e1rm, weightUnit),
        )}
        records={points.map((point) => point.isPr)}
        unit={weightUnit}
      />

      <h3 className="mt-5 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        Volume per session
      </h3>
      <BarChart
        label="Working volume per session — load times reps, warmups excluded."
        values={points.map((point) => Units.kgToDisplay(point.volume, weightUnit))}
      />

      <h3 className="mt-5 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        Personal records
      </h3>
      {records.length === 0 ? (
        <p className="mt-1 text-sm text-text-muted">None yet — the first session is the baseline to beat.</p>
      ) : (
        <ul className="mt-1">
          {records.slice(0, 8).map((point) => (
            <li
              key={point.loggedSessionId}
              className="flex items-baseline gap-2 border-b border-border py-1.5 text-sm leading-snug"
            >
              <span className="font-numeric text-[0.5625rem] font-semibold tracking-widest text-confirm uppercase">
                PR
              </span>
              <span>
                {point.topSet !== undefined && `${load(point.topSet.load)} × ${point.topSet.reps}`}
              </span>
              <span className="text-text-muted">· e1RM {point.e1rm !== undefined && load(point.e1rm)}</span>
              <span className="ml-auto font-numeric text-[0.625rem] text-text-faint">
                {shortDate(point.performedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Bodyweight: log today's reading, see the smoothed trend. The raw readings
 * are dots and the trend is the line, because the trend is the answer and a
 * reading is one noisy sample of it — `Stats.bodyweightTrend` says why.
 */
function Bodyweight({ handle }: { readonly handle: BodyweightHandle }) {
  const weightUnit = useWeightUnit();
  const today = Stats.localDateKey(new Date());
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState<"idle" | "running" | { readonly error: string }>("idle");

  const entries = handle.state.status === "ready" ? handle.state.entries : [];
  const points = Stats.bodyweightTrend(entries);
  const latest = points[points.length - 1];
  const shown = (kg: number) => Units.formatLoad(kg, weightUnit);
  const change = (days: number) => {
    const delta = Stats.trendChange(points, days);
    if (delta === undefined) return undefined;
    const value = Units.kgToDisplay(Math.abs(delta), weightUnit);
    return `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${value} ${weightUnit}`;
  };

  const parsed = Number(draft.trim().replace(",", "."));
  const valid = draft.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
  const save = () => {
    if (!valid) return;
    setSaving("running");
    handle.log(today, Units.displayToKg(parsed, weightUnit)).then(
      () => {
        setSaving("idle");
        setDraft("");
      },
      (cause: unknown) => setSaving({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
  };

  return (
    <section>
      <SectionHeading>Bodyweight</SectionHeading>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <input
          inputMode="decimal"
          aria-label={`Today's bodyweight in ${weightUnit}`}
          placeholder={latest === undefined ? weightUnit : String(Units.kgToDisplay(latest.weightKg, weightUnit))}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-24 rounded border border-border-strong bg-transparent px-2 py-1.5 font-numeric text-sm tabular-nums"
        />
        <span className="text-xs text-text-muted">{weightUnit}</span>
        <button
          type="submit"
          disabled={!valid || saving === "running"}
          className="rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken disabled:opacity-40"
        >
          {entries.some((e) => e.date === today) ? "Replace today's" : "Log today"}
        </button>
      </form>
      {typeof saving === "object" && <p className="mt-1 text-xs text-danger">Could not save — {saving.error}</p>}

      {handle.state.status === "loading" ? (
        <Notice>Loading…</Notice>
      ) : handle.state.status === "failed" ? (
        <Notice>Could not load bodyweight — {handle.state.reason}</Notice>
      ) : latest === undefined ? (
        <Notice>Log a reading each morning and the trend shows up here.</Notice>
      ) : (
        <>
          <p className="mt-4 text-sm leading-snug">
            Trend <span className="font-semibold">{shown(latest.trendKg)}</span>
            <span className="text-text-muted">
              {change(7) !== undefined && ` · ${change(7)} this week`}
              {change(30) !== undefined && ` · ${change(30)} in 30 days`}
            </span>
          </p>
          {points.length > 1 && (
            <LineChart
              label="Bodyweight trend, smoothed across daily readings."
              values={points.map((point) => Units.kgToDisplay(point.trendKg, weightUnit))}
              dots={points.map((point) => Units.kgToDisplay(point.weightKg, weightUnit))}
              unit={weightUnit}
            />
          )}
          <ul className="mt-3">
            {[...points]
              .reverse()
              .slice(0, 7)
              .map((point) => (
                <li
                  key={point.date}
                  className="flex items-baseline gap-2 border-b border-border py-1.5 text-sm leading-snug"
                >
                  <span className="font-numeric tabular-nums">{shown(point.weightKg)}</span>
                  <span className="text-text-muted">{shortDate(`${point.date}T12:00:00`)}</span>
                  <button
                    type="button"
                    onClick={() => void handle.remove(point.date)}
                    aria-label={`Remove the reading for ${point.date}`}
                    className="ml-auto font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase underline underline-offset-4"
                  >
                    remove
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** A neutral line over the series, records dotted green, min and max labelled on the axis. */
export function LineChart({
  label,
  values,
  records,
  dots,
  unit,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<number | undefined>;
  readonly records?: ReadonlyArray<boolean>;
  /** Raw samples drawn as faint dots on the same scale as the line (bodyweight's readings under its trend). */
  readonly dots?: ReadonlyArray<number>;
  readonly unit: string;
}) {
  const plot = Stats.plotSeries(values, CHART, dots);
  if (plot.points.length === 0) return null;
  // The dots ride the line's scale: plotted as their own series against the same fit.
  const dotPlot = dots === undefined ? [] : Stats.plotSeries(dots, CHART, values.flatMap((v) => (v === undefined ? [] : [v]))).points;
  const path = plot.points.map((point, i) => `${i === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const tenth = (value: number) => Math.round(value * 10) / 10;
  const hi = tenth(Math.max(...plot.points.map((p) => p.value)));
  const lo = tenth(Math.min(...plot.points.map((p) => p.value)));
  return (
    <figure className="mt-3">
      <svg
        role="img"
        aria-label={label}
        viewBox={`-6 -6 ${CHART.width + 12} ${CHART.height + 12}`}
        className="h-auto w-full overflow-visible"
      >
        <line x1={0} x2={CHART.width} y1={CHART.height} y2={CHART.height} className="stroke-border" strokeWidth={1} />
        {dotPlot.map((point) => (
          <circle key={`dot-${point.index}`} cx={point.x} cy={point.y} r={1.75} className="fill-text-faint" />
        ))}
        <path d={path} fill="none" className="stroke-text" strokeWidth={1.5} strokeLinejoin="round" />
        {plot.points.map((point) => (
          <circle
            key={point.index}
            cx={point.x}
            cy={point.y}
            r={records?.[point.index] === true ? 3.5 : 2}
            className={records?.[point.index] === true ? "fill-confirm" : "fill-text"}
          />
        ))}
      </svg>
      <figcaption className="mt-1 flex justify-between font-numeric text-[0.625rem] text-text-faint">
        <span>
          low {lo} {unit}
        </span>
        <span>
          high {hi} {unit}
        </span>
      </figcaption>
    </figure>
  );
}

function BarChart({ label, values }: { readonly label: string; readonly values: ReadonlyArray<number> }) {
  const max = Math.max(0, ...values);
  if (max === 0) return <p className="mt-1 text-sm text-text-muted">No loaded sets to total.</p>;
  const height = 48;
  const gap = 2;
  const width = Math.max(1, (CHART.width - gap * (values.length - 1)) / values.length);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${CHART.width} ${height}`} className="mt-2 h-12 w-full">
      {values.map((value, index) => {
        const h = (value / max) * height;
        return (
          <rect
            key={index}
            x={index * (width + gap)}
            y={height - h}
            width={width}
            height={h}
            className="fill-text-faint"
          />
        );
      })}
    </svg>
  );
}
