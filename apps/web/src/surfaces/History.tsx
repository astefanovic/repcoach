// History (issue #114 Part 2): its own route off Today, not folded into
// Stats (owner's decision) — a reverse-chronological list of finished
// sessions. Tapping a row reopens the existing Logging surface, which lands
// in backfill mode automatically (`Logging.tsx`'s `model.active === false`).
//
// The list itself follows Today's picker language: border-bottom rows, no
// cards (ui-surfaces.md's settled idiom). Offline renders the honest
// caution state rather than inventing a local cache — History has no
// offline story, unlike the Plan (ADR 0009).
import type { LoggedSessionSummary } from "@repcoach/contracts";

import { plural } from "../ui/chrome.ts";

function Notice({ children }: { readonly children: React.ReactNode }) {
  return <p className="mt-4 text-sm leading-snug text-text-muted">{children}</p>;
}

export function History({
  offline,
  state,
  onOpen,
}: {
  readonly offline: boolean;
  readonly state:
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly sessions: ReadonlyArray<LoggedSessionSummary> }
    | { readonly status: "failed"; readonly reason: string };
  readonly onOpen: (loggedSessionId: LoggedSessionSummary["loggedSessionId"]) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-10">
      <header className="border-b border-border-strong pt-5 pb-3">
        <div className="font-numeric text-xs tracking-widest text-text-faint uppercase">History</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight @2xl:text-3xl">Past sessions</h1>
      </header>

      {offline ? (
        <Notice>
          Not connected to home — History lives on the home server and can't be read from here.
        </Notice>
      ) : state.status === "loading" ? (
        <Notice>Loading history…</Notice>
      ) : state.status === "failed" ? (
        <Notice>Could not load history — {state.reason}</Notice>
      ) : state.sessions.length === 0 ? (
        <p className="mt-8 text-center font-numeric text-[0.6875rem] tracking-widest text-text-faint uppercase">
          No finished sessions yet
        </p>
      ) : (
        <ul>
          {state.sessions.map((session) => (
            <li key={session.loggedSessionId}>
              <button
                onClick={() => onOpen(session.loggedSessionId)}
                className="flex w-full items-center gap-3 border-b border-border py-3.5 text-left active:bg-surface-sunken"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[1.0625rem] leading-tight font-medium">
                    {session.name ?? "Session"}
                  </span>
                  <span className="mt-0.5 block font-numeric text-xs text-text-muted">
                    {new Date(session.finishedAt).toLocaleDateString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}{" "}
                    · {session.loggedSetCount} of {plural(session.totalSetCount, "set")}
                  </span>
                </span>
                <span className="font-numeric text-xs font-semibold tracking-widest text-text-muted uppercase">
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
