// Today (#72), on the real Plan.
//
// Not a redesign: the session picker and the coach output are D's, settled by
// #42/#43 and carried over. What changed is the source — `initialPlan` and
// `templateSetCount` are gone, replaced by the live `PlanSnapshot` and
// `Plan.summarizePlanSession` from the runtime, so the picker and the Plan
// editor cannot disagree about how long a day is.
import { Plan as PlanRuntime } from "@repcoach/client-runtime";
import type { PlanSnapshot, SessionId } from "@repcoach/contracts";

import type { InFlightSession } from "../runtime/inFlightSession.ts";
import { plural } from "../ui/chrome.ts";
import { CoachOutput } from "./CoachOutput.tsx";

export function Today({
  plan,
  stale,
  inFlight,
  nextUp,
  starting,
  startError,
  onResume,
  onStart,
  onPlan,
  onHistory,
  onStats,
  onProgress,
}: {
  readonly plan: PlanSnapshot;
  /** The Plan came from the durable cache, so nothing here can be started. */
  readonly stale: boolean;
  readonly inFlight: InFlightSession | undefined;
  /** ADR 0023's derived hint; ignored while a workout is in flight or if it no longer names a startable session. */
  readonly nextUp: SessionId | undefined;
  /** The Session currently being instantiated, if any — Start is a round-trip. */
  readonly starting: SessionId | undefined;
  readonly startError: string | undefined;
  readonly onResume: (session: InFlightSession) => void;
  readonly onStart: (sessionId: SessionId) => void;
  readonly onPlan: () => void;
  /** History (issue #114 Part 2) — its own route, not a fifth dock destination. */
  readonly onHistory: () => void;
  /** Stats (issue #117) — same call: its own route, not a fifth dock destination. */
  readonly onStats: () => void;
  /** Progress — same call again: its own route, not a fifth dock destination. */
  readonly onProgress: () => void;
}) {
  const today = new Date();
  const summaries = plan.sessions.map((session, index) =>
    PlanRuntime.summarizePlanSession(session, index),
  );
  // ADR 0023 §3: the hero slot is Resume's while a workout is in flight, and
  // next up's otherwise — but only for a session that is still in the Plan
  // and can be started, since the hint may be a cached one.
  const nextUpIndex = plan.sessions.findIndex((session) => session.id === nextUp);
  const nextUpSummary =
    inFlight === undefined && nextUpIndex !== -1 && !summaries[nextUpIndex]!.isEmpty
      ? summaries[nextUpIndex]
      : undefined;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-8 @2xl:px-8">
      <header className="border-b border-border-strong pt-5 pb-3">
        <div className="font-numeric text-xs tracking-widest text-text-faint uppercase">
          {today.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight @2xl:text-3xl">Today</h1>
      </header>

      <div className="@2xl:grid @2xl:grid-cols-[1fr_30rem] @2xl:gap-10">
        <section>
          {/* #42: while a Logged Session is in flight, the hero is Resume. This
              is what makes Logging-as-a-mode safe — a locked phone mid-workout
              cannot orphan the session (story 5). The pointer survives a
              reload, so this decision is made on the first render rather than
              after a fetch. */}
          {inFlight !== undefined && (
            <button
              onClick={() => onResume(inFlight)}
              className="mt-5 flex w-full items-center gap-3 rounded-control bg-confirm px-4 py-3 text-left text-canvas"
            >
              <span className="flex-1">
                <span className="block font-numeric text-[0.625rem] tracking-widest uppercase opacity-80">
                  in progress · started {new Date(inFlight.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="block text-[1.0625rem] font-semibold">
                  Resume — {titleOf(plan, inFlight.prescribedSessionId)}
                </span>
              </span>
              <span className="font-numeric text-xs font-semibold tracking-widest uppercase">→</span>
            </button>
          )}

          {nextUpSummary !== undefined && (
            <button
              onClick={() => onStart(plan.sessions[nextUpIndex]!.id)}
              disabled={stale || starting !== undefined}
              className="mt-5 flex w-full items-center gap-3 rounded-control bg-confirm px-4 py-3 text-left text-canvas disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-numeric text-[0.625rem] tracking-widest uppercase opacity-80">
                  next up
                </span>
                <span className="block truncate text-[1.0625rem] font-semibold">{nextUpSummary.title}</span>
              </span>
              <span className="font-numeric text-xs font-semibold tracking-widest uppercase">
                {starting === plan.sessions[nextUpIndex]!.id ? "Starting…" : stale ? "Offline" : "Start"}
              </span>
            </button>
          )}

          <h2 className="mt-6 mb-1 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
            {inFlight !== undefined ? "Or pick another session" : "Pick today's session"}
          </h2>
          {/* The picker reads the Plan's Prescribed Sessions in their authored
              order (story 3) — ADR 0007's "no auto-select": you pick, and
              picking instantiates a copy (story 4). */}
          <ul>
            {plan.sessions.map((session, index) => {
              const summary = summaries[index]!;
              // Offline, Start would need a round-trip it cannot make, so the
              // row is disabled rather than offering a tap that fails. The
              // Plan still renders, which is story 2's whole point.
              const disabled = summary.isEmpty || stale || starting !== undefined;
              return (
                <li key={session.id}>
                  <button
                    onClick={() => onStart(session.id)}
                    disabled={disabled}
                    className="flex w-full items-center gap-3 border-b border-border py-3.5 text-left active:bg-surface-sunken disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[1.0625rem] leading-tight font-medium">
                        {summary.title}
                      </span>
                      {summary.isEmpty ? (
                        <span className="mt-0.5 block font-numeric text-xs text-deviation">
                          empty — nothing to run yet
                        </span>
                      ) : (
                        <span className="mt-0.5 block font-numeric text-xs text-text-muted">
                          {plural(summary.entryCount, "exercise")} ·{" "}
                          {plural(summary.setCount, "set")}
                        </span>
                      )}
                    </span>
                    {!summary.isEmpty && (
                      <span className="font-numeric text-xs font-semibold tracking-wider text-confirm uppercase">
                        {starting === session.id ? "Starting…" : stale ? "Offline" : "Start"}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {startError !== undefined && (
            <p className="mt-3 font-numeric text-[0.6875rem] tracking-wide text-deviation uppercase">
              could not start · {startError}
            </p>
          )}

          <div className="mt-3 flex items-center gap-4">
            <button
              onClick={onPlan}
              className="font-numeric text-xs tracking-wider text-text-muted uppercase underline underline-offset-4"
            >
              Edit plan →
            </button>
            <button
              onClick={onHistory}
              className="font-numeric text-xs tracking-wider text-text-muted uppercase underline underline-offset-4"
            >
              History →
            </button>
            <button
              onClick={onStats}
              className="font-numeric text-xs tracking-wider text-text-muted uppercase underline underline-offset-4"
            >
              Stats →
            </button>
            <button
              onClick={onProgress}
              className="font-numeric text-xs tracking-wider text-text-muted uppercase underline underline-offset-4"
            >
              Progress →
            </button>
          </div>
        </section>

        {/* D's full coach output, not a summary of it — the evidence tables,
            the named rule, the trust-marked sources and the "where this could
            be wrong" block. */}
        <section className="mt-8 @2xl:mt-0">
          <CoachOutput />
        </section>
      </div>
    </div>
  );
}

/** The in-flight session's name, from the Plan it was instantiated from. */
function titleOf(plan: PlanSnapshot, sessionId: SessionId): string {
  const index = plan.sessions.findIndex((session) => session.id === sessionId);
  const session = plan.sessions[index];
  // A Session deleted from the Plan since the workout started is still a real
  // in-flight workout — the Logged Session is a copy (ADR 0006/0007) — so
  // this must degrade to a label rather than to nothing.
  return session === undefined ? "your session" : PlanRuntime.planSessionTitle(session, index);
}

/* --------------------------------------------------- Today's no-Plan state ---
   #42 makes this the Intake invitation, and ADR 0014 §8 makes it the one place
   the offline check has to happen: Intake is the single flow that cannot degrade
   gracefully — the app is local-first but there is no local coach — so the
   invitation must not dangle a door that dead-ends. It is built here rather than
   inside the takeover on purpose. Discovering the coach is unreachable AFTER
   entering a chrome-free takeover means the takeover exists only to apologise.
------------------------------------------------------------------------------ */

export function TodayEmptyState({
  offline,
  onIntake,
  onManual,
}: {
  readonly offline: boolean;
  readonly onIntake: () => void;
  readonly onManual: () => void;
}) {
  return (
    <div className="mx-auto max-w-md px-4 pt-16 pb-10 text-center">
      <p className="font-numeric text-[0.6875rem] tracking-widest text-text-faint uppercase">
        No plan yet
      </p>
      <h1 className="mt-2 text-2xl leading-snug font-semibold tracking-tight">
        {offline ? "The coach is out of reach right now" : "Let the coach write your first plan"}
      </h1>

      {offline ? (
        <>
          {/* yellow, not red: offline is expected, and #42 already spends yellow
              on exactly this. The copy states the constraint rather than the
              symptom, because "the coach runs on your home server" is the fact
              that makes the manual path make sense. */}
          <p className="mx-auto mt-3 max-w-sm text-sm leading-normal text-text-muted">
            The coach runs on your home server and this device can't see it. Everything else in the
            app works offline — this is the one thing that can't.
          </p>
          <button
            onClick={onManual}
            className="mt-6 h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase"
          >
            Write the first plan myself
          </button>
          <p className="mt-3 font-numeric text-[0.625rem] leading-relaxed tracking-wide text-deviation uppercase">
            The coach can revise it later, once it's reachable
          </p>
        </>
      ) : (
        <>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-normal text-text-muted">
            Four questions about what you're after and what you can train with. It drafts a plan,
            you argue with it until it's right, and it checks its own sources before you accept.
          </p>
          <button
            onClick={onIntake}
            className="mt-6 h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase"
          >
            Answer four questions
          </button>
          <button
            onClick={onManual}
            className="mt-4 font-numeric text-[0.625rem] tracking-wide text-text-muted uppercase underline underline-offset-4"
          >
            Or write the plan yourself →
          </button>
        </>
      )}
    </div>
  );
}

/** What a surface shows while its data is on the way. */
export function Loading({ title }: { readonly title: string }) {
  return (
    <div className="grid min-h-64 place-items-center p-10 text-center" role="status">
      <p className="font-numeric text-[0.6875rem] tracking-widest text-text-faint uppercase">
        {title}…
      </p>
    </div>
  );
}

/** An honest error state (story 38) — the surface says what went wrong rather than sitting empty. */
export function SurfaceError({
  title,
  reason,
  onRetry,
}: {
  readonly title: string;
  readonly reason: string;
  readonly onRetry?: () => void;
}) {
  return (
    <div className="mx-auto max-w-md px-4 pt-16 pb-10 text-center">
      <p className="font-numeric text-[0.6875rem] tracking-widest text-deviation uppercase">
        {title}
      </p>
      <pre className="mt-3 overflow-x-auto rounded-control bg-surface-sunken p-3 text-left text-xs text-text-muted">
        {reason}
      </pre>
      {onRetry !== undefined && (
        <button
          onClick={onRetry}
          className="mt-5 h-tap rounded-control border border-border-strong px-4 font-numeric text-xs tracking-widest uppercase"
        >
          Try again
        </button>
      )}
    </div>
  );
}
