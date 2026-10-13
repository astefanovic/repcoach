// The coach item's presentation, shared by Today's Proposal card and the
// Coach surface's permanent record (#79).
//
// Lifted out of `CoachOutput.tsx` unchanged in look. #42 split one feed into
// two surfaces — Today carries undecided Proposals, Coach carries the record
// — and the split is only honest if an item reads identically in both places:
// what the user accepted on Today is the thing they can go back and re-read on
// Coach. Two copies of this markup would drift, and the drift would be
// invisible until the day it mattered.
//
// D's thesis, kept intact: the coach is not an oracle. It is a run that made a
// claim from measurements, under a named rule, from sources of stated trust,
// with a place it might be wrong. The working IS the UI.
//
// D's spacing rhythm, kept intact — three deliberate steps:
//   within a block   0.375rem   rows of one table
//   between blocks   1rem       measurements -> rule -> sources
//   between items    1.5rem + a 2px rule that fences the item
// Every block of working hangs off a left hairline so a subheading visibly
// OWNS what follows it.
import type React from "react";

import type { DecisionWorking } from "@repcoach/contracts";

import type { DecisionWorkingState } from "../runtime/useDecisionWorking.ts";

/** typed, bracketed kind marker — the thing the row IS, stated plainly */
export function Kind({ children, tone }: { children: React.ReactNode; tone?: "muted" }) {
  return (
    <span
      className={`font-numeric text-[0.625rem] font-semibold tracking-widest uppercase ${
        tone === "muted" ? "text-text-muted" : "text-accent"
      }`}
    >
      [{children}]
    </span>
  );
}

export function Trust({ verified }: { verified: boolean }) {
  return (
    <span
      className={`font-numeric text-[0.625rem] tracking-widest uppercase ${
        verified ? "text-evidence-strong" : "text-deviation"
      }`}
    >
      [{verified ? "verified" : "unverified"}]
    </span>
  );
}

/** the item fence: 2px rule, and a header that is itself the collapse control */
export function ItemHeader({
  kind,
  tone,
  position,
  window,
  headline,
  subline,
  collapsedHint,
  open,
  onToggle,
}: {
  kind: string;
  tone?: "muted";
  position?: string;
  window?: string;
  headline: string;
  subline?: React.ReactNode;
  collapsedHint: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="w-full border-t-2 border-border-strong pt-2.5 pb-1 text-left active:bg-surface-sunken"
    >
      <span className="flex items-center gap-2">
        <span className="w-3 font-numeric text-[0.625rem] text-text-muted">{open ? "▾" : "▸"}</span>
        <Kind tone={tone}>{kind}</Kind>
        {position !== undefined && (
          <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
            {position}
          </span>
        )}
        {window !== undefined && (
          <span className="ml-auto font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
            {window}
          </span>
        )}
      </span>

      {/* the pl-5 gutter aligns the headline with the indented working below it;
          collapsed there is nothing to align to, so it sits flush */}
      <span
        className={`mt-1.5 block text-[1.0625rem] leading-snug font-semibold ${open ? "pl-5" : ""}`}
      >
        {headline}
      </span>
      {open && subline && <span className="mt-1 block pl-5">{subline}</span>}
      {!open && (
        <span className="mt-1 block font-numeric text-[0.6875rem] tracking-wide text-text-muted">
          {collapsedHint} —{" "}
          <span className="text-accent underline underline-offset-2">show working</span>
        </span>
      )}
    </button>
  );
}

/** a titled block of working, visibly owned by its heading via the left rule */
export function Block({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "deviation";
  children: React.ReactNode;
}) {
  return (
    <section
      className={`mt-4 border-l pl-3.5 first:mt-3 ${
        tone === "deviation" ? "border-deviation/50" : "border-border"
      }`}
    >
      <h4
        className={`font-numeric text-[0.625rem] tracking-widest uppercase ${
          tone === "deviation" ? "text-deviation" : "text-text-muted"
        }`}
      >
        {title}
        {tone === "deviation" && (
          <span className="ml-1.5 rounded-sm bg-deviation/15 px-1 py-0.5 text-[0.5625rem] font-semibold normal-case tracking-normal text-deviation">
            flagged
          </span>
        )}
      </h4>
      <div className="mt-1.5">{children}</div>
    </section>
  );
}

/** a measurement that moved the coach's way reads green, like a logged tick;
    a flat or absent one stays neutral. Nothing here is ever red — red is the
    proposed change, not the evidence for it. */
const deltaTone = (delta: string) =>
  delta.startsWith("+") || /^(\d+)\/\1$/.test(delta) ? "text-confirm" : "text-text-muted";

/**
 * The window an item's header shows, from the run's own data window: the
 * sessions it read and the dates it read them over. `undefined` when the row
 * carries no data window, in which case the header simply has no window —
 * inventing "recently" would be the surface asserting something the record
 * does not say.
 */
export function windowLabel(working: DecisionWorking | undefined): string | undefined {
  const dataWindow = working?.dataWindow;
  if (dataWindow === undefined) return undefined;
  const sessions = dataWindow.session_ids_considered.length;
  const span = formatSpan(dataWindow.window_from, dataWindow.window_to);
  const sessionPart = sessions === 0 ? undefined : `${sessions} session${sessions === 1 ? "" : "s"}`;
  return [sessionPart, span].filter((part) => part !== undefined).join(" · ") || undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A bare day — "3 Jul". Shared with the run rail, which dates every run node. */
export const formatDay = (iso: string): string => {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
};

/** The span a run read over, from its data window. `undefined` when it recorded neither end. */
export const formatSpan = (from: string | undefined, to: string | undefined): string | undefined => {
  if (from === undefined && to === undefined) return undefined;
  if (from === undefined) return `to ${formatDay(to as string)}`;
  if (to === undefined) return `from ${formatDay(from)}`;
  return `${formatDay(from)} – ${formatDay(to)}`;
};

/**
 * The collapsed one-liner: what is inside this item, counted rather than
 * described. It is written from what the working actually holds, so an item
 * with no measurements never promises any — before the working has loaded it
 * says nothing at all rather than guessing.
 */
export function collapsedHint(working: DecisionWorking | undefined): string {
  if (working === undefined) return "show the working";
  const parts = [
    working.measurements === undefined || working.measurements.length === 0
      ? undefined
      : plural(working.measurements.length, "measurement"),
    working.citations.length === 0 ? undefined : plural(working.citations.length, "source"),
    working.uncertainty === undefined ? undefined : "1 caveat",
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "show the working" : parts.join(" · ");
}

export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * The working itself: every block the run actually filled in, and no block it
 * did not (#79).
 *
 * This is the whole reason the three fields are optional in the contract. A
 * card that always renders "Where this could be wrong" teaches the user to
 * skip it; one that renders it only when the coach named something concrete
 * makes its presence mean something. So there are no placeholders here and no
 * "none given" rows — an absent field is an absent block.
 */
export function Working({ state }: { readonly state: DecisionWorkingState }) {
  if (state.status === "loading" || state.status === "idle") {
    return (
      <p className="mt-3 font-numeric text-[0.6875rem] tracking-wide text-text-faint uppercase">
        Loading the working…
      </p>
    );
  }
  if (state.status === "failed") {
    // The summary above is still true and still readable; only the working is
    // missing, so this says exactly that and nothing louder.
    return (
      <p className="mt-3 font-numeric text-[0.6875rem] tracking-wide text-text-muted">
        Could not load the working — {state.reason}
      </p>
    );
  }

  const { working } = state;
  const measurements = working.measurements ?? [];

  return (
    <>
      {measurements.length > 0 && (
        <Block title="What I measured">
          <table className="w-full">
            <tbody>
              {measurements.map((measurement) => (
                <tr key={measurement.label} className="border-b border-border last:border-0">
                  <td className="py-1.5 pr-2 text-sm leading-snug">{measurement.label}</td>
                  <td className="py-1.5 pr-2 text-right font-numeric text-xs tabular-nums whitespace-nowrap text-text-muted">
                    {measurement.series}
                  </td>
                  <td
                    className={`w-14 py-1.5 text-right font-numeric text-xs font-semibold tabular-nums ${deltaTone(measurement.delta)}`}
                  >
                    {measurement.delta}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Block>
      )}

      {working.rule !== undefined && (
        <Block title="The rule I applied">
          <p className="text-sm leading-snug">{working.rule}</p>
        </Block>
      )}

      <Block title="Reasoning">
        <p className="text-sm leading-snug">{working.rationale}</p>
      </Block>

      {working.citations.length > 0 && (
        <Block title="Sources">
          <ul className="space-y-2">
            {working.citations.map((citation, index) => (
              <li key={index} className="text-sm leading-snug">
                <Trust verified={citation.trust === "corpus-verified"} /> {citation.claim}
                <span className="mt-0.5 block font-numeric text-[0.6875rem] text-text-faint">
                  {citation.trust === "corpus-verified"
                    ? citation.source_url
                    : `${citation.source_url} — retrieved, not corpus-verified`}
                </span>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {working.uncertainty !== undefined && (
        <Block title="Where this could be wrong" tone="deviation">
          <p className="text-sm leading-snug text-deviation">{working.uncertainty}</p>
        </Block>
      )}
    </>
  );
}

/**
 * Run provenance — which run produced this, over what, when.
 *
 * #43's footer also carried the model and the token cost. Neither is stored
 * per Decision (`RunState` knows the *last* run's usage and nothing else), so
 * they are not here: a footer that named a model would be naming a guess.
 */
export function Provenance({ working }: { readonly working: DecisionWorking | undefined }) {
  const dataWindow = working?.dataWindow;
  if (dataWindow === undefined) return null;
  const sessions = dataWindow.session_ids_considered.length;
  return (
    <p className="mt-5 border-t border-border pt-2 font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
      {cadenceLabel(dataWindow.cadence)} · ran {formatDay(dataWindow.ran_at)} ·{" "}
      {plural(sessions, "session")} read · roster {dataWindow.evidence_roster_version}
    </p>
  );
}

/**
 * The cadence, in the words CONTEXT uses for it. Shared with the run rail so a
 * run and the Decisions it produced cannot end up calling the same run two
 * different things on two parts of one screen.
 */
export const cadenceLabel = (cadence: string): string =>
  cadence === "session-review"
    ? "Session review"
    : cadence === "cycle-review"
      ? "Cycle review"
      : cadence === "revision-run"
        ? "Revision run"
        : cadence === "intake"
          ? "Intake"
          : "On demand";
