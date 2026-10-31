// The #42 chrome. Built in the prototype, kept verbatim by #72 — the visual
// and interaction design is settled (ui-surfaces.md) and this port changes
// only what is underneath it. The one substantive change: Coach's badge count
// is now a prop fed by real undecided-Proposal state (user story 36) instead
// of a fixture constant.
//
// What this encodes from the settled IA:
//   · Four destinations, always visible, in order: Today, Plan, Coach, Settings.
//   · Desktop = persistent sidebar, phone = bottom dock, switching at 768px.
//     #42 says VIEWPORT width, but the prototype stages a 412px phone inside a
//     desktop browser — so a `md:` media query measures the wrong box and puts
//     the sidebar inside the phone. The switch is a CONTAINER query on the
//     shell's own box (`@3xl` = 48rem = 768px exactly), which equals viewport
//     width in the real app and equals the frame here. Same rule, right box.
//   · One persistent single-line status strip, topmost, spanning the CONTENT
//     column only (never the sidebar), outside the content container.
//   · Numeric badge on Coach only, counting decisions owed. It must not reflow
//     the other slots — hence the fixed-width badge gutter on every slot.
//   · Logging suppresses the destination chrome on both shells but KEEPS the
//     strip, and exposes exactly one back affordance to Today.
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { StripState } from "./chrome.ts";

export type Dest = "today" | "plan" | "coach" | "settings";

/** The four destinations' real URLs — the one place both `Dock` and
 *  `Sidebar` look up where a destination's `<Link>` actually goes. */
export const DEST_PATHS: Readonly<Record<Dest, string>> = {
  today: "/",
  plan: "/plan",
  coach: "/coach",
  settings: "/settings",
};

/**
 * What the Coach glyph carries. Two independent signals, deliberately not
 * merged into one (#150, ADR 0021):
 *
 *   · `coach` — decisions owed, a count in the badge gutter (#42: observations
 *     never nag, only Proposals do). `0` renders nothing rather than a zero
 *     badge.
 *   · `coachPip` — a dot meaning "a Deliberation run has settled that you have
 *     not opened Coach to see". Different question from the count, so a
 *     different mark in a different corner: they never compete for the gutter,
 *     and neither one hides the other. The dot is absolutely positioned inside
 *     the reserved glyph box, so lighting or clearing it shifts no slot.
 */
export interface ChromeBadges {
  readonly coach: number;
  readonly coachPip: boolean;
}

const NO_BADGES: ChromeBadges = { coach: 0, coachPip: false };

const DESTS: readonly { readonly id: Dest; readonly label: string; readonly glyph: string }[] = [
  { id: "today", label: "Today", glyph: "◎" },
  { id: "plan", label: "Plan", glyph: "≡" },
  { id: "coach", label: "Coach", glyph: "✦" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

/* -------------------------------------------------------------- status strip */

export function StatusStrip({ state, right }: { state: StripState; right?: ReactNode }) {
  // Neutral proves liveness without spending a semantic colour; yellow is the
  // exception (offline mid-gym is expected, not a failure); green is TEMPORAL
  // only — a ~3s flash on run completion, then back to neutral. Red (#111,
  // amending #42's never-red rule) is the hard failure: broken rather than
  // degraded, and it does not clear itself. See `chrome.ts`.
  const tone =
    state.tone === "error"
      ? "bg-danger-quiet text-danger"
      : state.tone === "caution"
        ? "bg-deviation-quiet text-deviation"
        : state.tone === "flash"
          ? "bg-confirm-quiet text-confirm"
          : "bg-surface-sunken text-text-muted";
  const dot =
    state.tone === "error"
      ? "bg-danger"
      : state.tone === "caution"
        ? "bg-deviation"
        : state.tone === "flash"
          ? "bg-confirm"
          : "bg-text-faint";

  return (
    <div
      className={`flex items-center gap-2 border-b border-border px-4 py-1.5 font-numeric text-[0.6875rem] tracking-wide @2xl:px-8 ${tone}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{state.text}</span>
      {right && <span className="ml-auto shrink-0 text-text-faint">{right}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------- phone dock */

function Dock({ active, badges }: { active: Dest; badges: ChromeBadges }) {
  return (
    // Two things worth keeping: sticky must sit on the nav itself, not on a
    // `hidden`-toggling wrapper (a wrapper that hugs the dock's own height
    // leaves it nowhere to stick to); and the query is /shell-named, because
    // the dock lives inside the CONTENT container and would otherwise measure
    // the column rather than the shell — showing a dock beside a sidebar.
    <nav className="sticky bottom-0 z-20 grid shrink-0 grid-cols-4 border-t border-border-strong bg-canvas pb-[env(safe-area-inset-bottom)] @3xl/shell:hidden">
      {DESTS.map((d) => {
        const on = d.id === active;
        return (
          <Link
            key={d.id}
            to={DEST_PATHS[d.id]}
            aria-current={on ? "page" : undefined}
            className={`flex h-tap flex-col items-center justify-center gap-0.5 active:bg-surface-sunken ${
              on ? "text-text" : "text-text-faint"
            }`}
          >
            {/* the badge gutter is reserved on EVERY slot, so Coach gaining or
                losing its count cannot shift the other three; the pip is a
                separate absolutely-positioned dot in the opposite corner, so
                it shifts nothing either */}
            <span className="relative text-base leading-none">
              {d.glyph}
              <span className="absolute -top-1 left-full ml-0.5 w-3 text-left font-numeric text-[0.5625rem] font-semibold text-accent">
                {d.id === "coach" && badges.coach > 0 ? badges.coach : ""}
              </span>
              {d.id === "coach" && badges.coachPip && (
                <span
                  aria-hidden
                  className="absolute top-0 right-full mr-0.5 size-1.5 rounded-full bg-accent"
                />
              )}
            </span>
            {d.id === "coach" && badges.coachPip && <span className="sr-only">new activity</span>}
            <span
              className={`font-numeric text-[0.5625rem] tracking-widest uppercase ${on ? "font-semibold" : ""}`}
            >
              {d.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}

/* ----------------------------------------------------------- desktop sidebar */

function Sidebar({ active, badges }: { active: Dest; badges: ChromeBadges }) {
  return (
    <nav className="hidden w-56 shrink-0 border-r border-border-strong bg-surface-sunken @3xl/shell:flex @3xl/shell:flex-col">
      <div className="border-b border-border px-4 py-3 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        RepCoach
      </div>
      <ul className="p-2">
        {DESTS.map((d) => {
          const on = d.id === active;
          return (
            <li key={d.id}>
              <Link
                to={DEST_PATHS[d.id]}
                aria-current={on ? "page" : undefined}
                className={`flex h-tap w-full items-center gap-3 rounded-control px-3 text-left ${
                  on ? "bg-canvas font-semibold" : "text-text-muted hover:bg-canvas/60"
                }`}
              >
                <span className="relative w-4 text-center text-base leading-none">
                  {d.glyph}
                  {d.id === "coach" && badges.coachPip && (
                    <span
                      aria-hidden
                      className="absolute top-0 -right-1 size-1.5 rounded-full bg-accent"
                    />
                  )}
                </span>
                <span className="text-sm">{d.label}</span>
                {d.id === "coach" && badges.coachPip && <span className="sr-only">new activity</span>}
                <span className="ml-auto w-5 text-right font-numeric text-[0.6875rem] font-semibold text-accent">
                  {d.id === "coach" && badges.coach > 0 ? badges.coach : ""}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ------------------------------------------------------------------ the shell */

export function Shell({
  active,
  strip,
  stripRight,
  badges = NO_BADGES,
  children,
}: {
  active: Dest;
  strip: StripState;
  stripRight?: ReactNode;
  badges?: ChromeBadges;
  children: ReactNode;
}) {
  return (
    // The outer element is ONLY a container — it carries no @3xl classes of its
    // own, because a container query resolves against an ANCESTOR container and
    // never against the element declaring it. The row/column switch therefore
    // has to live on a child.
    //
    // outer container = the shell's box, which decides sidebar vs dock.
    // inner container = the content column AFTER the sidebar, which decides
    // whether a surface gets two columns. They are supposed to disagree (#42):
    // at ~800px you get a sidebar and still-stacked content, because after the
    // sidebar there genuinely is not 42rem left.
    <div className="@container/shell min-h-dvh bg-canvas">
      <div className="flex min-h-dvh flex-col @3xl/shell:flex-row">
        <Sidebar active={active} badges={badges} />
        {/* the strip spans the content column, not the sidebar — hence its
            living inside this flex child rather than above the whole shell */}
        <div className="@container flex min-w-0 flex-1 flex-col">
          <StatusStrip state={strip} right={stripRight} />
          <div className="min-h-0 flex-1">{children}</div>
          <Dock active={active} badges={badges} />
        </div>
      </div>
    </div>
  );
}

/** Logging and Intake: destination chrome suppressed on BOTH shells. Logging
    keeps the strip (offline capture is the whole point) and gets one back. */
export function ModeShell({
  strip,
  stripRight,
  children,
}: {
  strip?: StripState;
  stripRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="@container flex min-h-dvh flex-col bg-canvas">
      {strip && <StatusStrip state={strip} right={stripRight} />}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
