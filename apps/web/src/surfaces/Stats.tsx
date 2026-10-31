// Stats (issue #117) — its own route off Today, not a fifth dock destination.
// #42's IA was settled at four and has held twice since (Revise/#60 folded a
// whole chat-style surface into a card rather than open a fifth slot); #114's
// History made the same call for its own new surface. This ticket's own
// watchlist entry (`docs/design/uat-watchlist.md`) says as much: whether a
// stats surface deserves a slot of its own is exactly the kind of thing daily
// use, not this ticket, should decide.
//
// The graph: a GitHub-contributions-style calendar heatmap, one cell per
// local calendar day, coloured by how many sets were logged that day.
// Intensity is sets (not sessions, not tonnage — see `Stats.getDailySetCounts`
// contract doc) bucketed by `@repcoach/client-runtime`'s `Stats.buildWeekColumns`
// against the user's OWN distribution, never a fixed absolute scale.
//
// Colour: built entirely from the `confirm` family (logging a set is a
// confirm) via `color-mix` against `--color-confirm` — no new tokens, and the
// empty cell is `--color-surface-sunken` (a neutral, not a tinted "almost
// confirm"), so an empty day reads as empty rather than as a faint failure.
// Card-less, same as everywhere else: no panel around the graph, hairline
// rules only.
//
// Phone-first layout: a year of week-columns does not fit 412px, so this
// picked horizontal scroll pinned to most recent over a responsive rolling
// window (the ticket's "pick one") — a wide desktop viewport just shows more
// of the same array without this component branching on a breakpoint.
import { useEffect, useRef } from "react";

import { Stats as StatsRuntime } from "@repcoach/client-runtime";
import type { DailySetCount } from "@repcoach/contracts";

/** ~1 year of columns, GitHub's own convention — the honest "have I trained this week" default needs only the rightmost column, which the pinned scroll guarantees is always in view. */
const WEEKS_BACK = 52;

/** `color-mix` percentages toward `--color-confirm`, one per non-empty bucket — tuned so bucket 1 is still clearly distinguishable from the empty cell, and bucket 4 is the full, saturated confirm colour. */
const BUCKET_MIX_PERCENT: Readonly<Record<1 | 2 | 3 | 4, number>> = { 1: 32, 2: 54, 3: 76, 4: 100 };

function localToday(): { readonly year: number; readonly month: number; readonly day: number } {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function cellBackground(bucket: 0 | 1 | 2 | 3 | 4): string {
  if (bucket === 0) return "var(--color-surface-sunken)";
  return `color-mix(in oklch, var(--color-confirm) ${BUCKET_MIX_PERCENT[bucket]}%, var(--color-surface-sunken))`;
}

function Notice({ children }: { readonly children: React.ReactNode }) {
  return <p className="mt-4 text-sm leading-snug text-text-muted">{children}</p>;
}

export function Stats({
  offline,
  state,
  onOpenDay,
}: {
  readonly offline: boolean;
  readonly state:
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly days: ReadonlyArray<DailySetCount> }
    | { readonly status: "failed"; readonly reason: string };
  readonly onOpenDay: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pinned to most recent: the last column (today's own week) is always the
  // one already in view, which is what makes "have I trained this week"
  // answerable with zero interaction.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [state.status === "ready"]);

  const ready = state.status === "ready";
  const columns = ready
    ? StatsRuntime.buildWeekColumns(state.days, { weeksBack: WEEKS_BACK, today: localToday() })
    : [];
  const hasAnyData = ready && state.days.some((d) => d.setCount > 0);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-10">
      <header className="border-b border-border-strong pt-5 pb-3">
        <div className="font-numeric text-xs tracking-widest text-text-faint uppercase">Stats</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight @2xl:text-3xl">Consistency</h1>
      </header>

      {offline ? (
        <Notice>
          Not connected to home — Stats lives on the home server and can't be read from here.
        </Notice>
      ) : state.status === "loading" ? (
        <Notice>Loading…</Notice>
      ) : state.status === "failed" ? (
        <Notice>Could not load Stats — {state.reason}</Notice>
      ) : (
        <div className="mt-5">
          <div ref={scrollRef} className="overflow-x-auto pb-2" role="img" aria-label="Workout consistency heatmap, one cell per day, coloured by sets logged.">
            <div className="flex w-max gap-[3px]">
              {columns.map((week, weekIndex) => (
                <div key={weekIndex} className="flex flex-col gap-[3px]">
                  {week.map((cell, dayIndex) =>
                    cell === undefined ? (
                      <div key={dayIndex} className="size-[13px]" />
                    ) : (
                      <button
                        key={dayIndex}
                        type="button"
                        onClick={cell.setCount > 0 ? onOpenDay : undefined}
                        disabled={cell.setCount === 0}
                        title={`${cell.date} · ${cell.setCount} ${cell.setCount === 1 ? "set" : "sets"}`}
                        aria-label={`${cell.date}, ${cell.setCount} sets logged`}
                        className="size-[13px] shrink-0 disabled:cursor-default"
                        style={{ backgroundColor: cellBackground(cell.bucket) }}
                      />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-1.5 font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
            <span>Less</span>
            {([0, 1, 2, 3, 4] as const).map((bucket) => (
              <span
                key={bucket}
                className="size-[11px]"
                style={{ backgroundColor: cellBackground(bucket) }}
              />
            ))}
            <span>More</span>
          </div>

          {!hasAnyData && (
            <p className="mt-6 text-center font-numeric text-[0.6875rem] tracking-widest text-text-faint uppercase">
              No sets logged yet
            </p>
          )}
        </div>
      )}
    </div>
  );
}
