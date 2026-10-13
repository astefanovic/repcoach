// The RepCoach web client's route table and shell.
//
// #50 established the routes; #72 makes what they render real. Every surface
// below now reads the live Plan, the live Logged Session and the outbox — the
// `prototype/spec/data.ts` fixtures and the `?session=` selectors that stood
// in for them are gone.
//
// | Route | Surface |
// |---|---|
// | `/` | Today |
// | `/plan`, `/plan/:sessionId` | Plan view, session editor |
// | `/coach`, `/coach/:proposalId` | Coaching feed, deep-linked Proposal |
// | `/settings` | Settings |
// | `/log/:loggedSessionId` | Logging — has a URL because Resume needs one, never in chrome |
// | `/intake` | Intake takeover |
// | `/history` | History (#114) — off Today, not a fifth dock destination |
// | `/stats` | Stats (#117) — same call as History |
// | `/progress` | Progress — e1RM and volume per lift, bodyweight; same call again |
//
// Both stub surfaces named in earlier revisions of this comment are now real:
// the Coaching feed shipped as #79's Coach record, and Settings ships here
// (#81) — model-per-cadence, the RPE capture control, and the run ledger's
// spend read. Intake was also out of #72's scope and is real as of #74 —
// `/intake` runs against the held-open runner session. Every route is wired
// end to end.
//
// The shell's sidebar/dock switch is a CONTAINER query rather than a media
// query (`ui/Shell.tsx`). In the real app the container *is* the viewport, so
// the same rule measures the real box — and the switch is on width alone
// (story 34), which is what makes resizing one window enough to see both
// forms.
import type { ReactNode } from "react";
import { useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";

import type { LoggedSessionId, PlanSnapshot, SessionId } from "@repcoach/contracts";

import { IntakeTakeover } from "./intake/IntakeTakeover.tsx";
import { startWorkout } from "./runtime/commands.ts";
import { useInFlightSession, type InFlightSession } from "./runtime/inFlightSession.ts";
import { useInFlightReconciliation } from "./runtime/useInFlightReconciliation.ts";
import { useNextUp } from "./runtime/useNextUp.ts";
import {
  useOutboxPendingCount,
  useRuntime,
  useRuntimeState,
  type RepCoachRuntime,
} from "./runtime/RuntimeProvider.tsx";
import { describeFailure } from "./runtime/rpc.ts";
import { statusStripState } from "./runtime/statusStrip.ts";
import { useConnectionState } from "./runtime/useConnectionState.ts";
import { useServerBuildRef } from "./runtime/useServerBuildRef.ts";
import { useExerciseCatalog } from "./runtime/useExerciseCatalog.ts";
import { useDailySetCounts } from "./runtime/useDailySetCounts.ts";
import { useBodyweight } from "./runtime/useBodyweight.ts";
import { useExerciseProgress } from "./runtime/useExerciseProgress.ts";
import { useLoggedSession } from "./runtime/useLoggedSession.ts";
import { useSessionHistory } from "./runtime/useSessionHistory.ts";
import { isEmptyPlan, planOf, usePlan } from "./runtime/usePlan.ts";
import { usePendingProposalCount } from "./runtime/usePendingProposals.ts";
import { useCoachActivityPip } from "./runtime/useCoachActivityPip.ts";
import { usePlanEditor } from "./runtime/usePlanEditor.ts";
import { useDeliberationActivity } from "./runtime/useDeliberationActivity.ts";
import { useRevisionActivity } from "./runtime/useRevisionActivity.ts";
import { Coach } from "./surfaces/Coach.tsx";
import { History } from "./surfaces/History.tsx";
import { Logging } from "./surfaces/Logging.tsx";
import { Plan } from "./surfaces/Plan.tsx";
import { Progress } from "./surfaces/Progress.tsx";
import { Settings } from "./surfaces/Settings.tsx";
import { Stats } from "./surfaces/Stats.tsx";
import { Placeholder, SurfaceError, Today, TodayEmptyState } from "./surfaces/Today.tsx";
import type { StripState } from "./ui/chrome.ts";
import type { ChromeBadges, Dest } from "./ui/Shell.tsx";
import { ModeShell, Shell } from "./ui/Shell.tsx";

/* ------------------------------------------------------------ the live strip */

/**
 * The status strip, fed by the real supervisor and outbox. Split into its own
 * component because the hooks it needs only exist once the runtime is ready,
 * and a component boundary is how React lets that be conditional without
 * breaking hook order.
 */
function LiveStrip({
  runtime,
  render,
}: {
  readonly runtime: RepCoachRuntime;
  readonly render: (strip: StripState) => ReactNode;
}) {
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  const pendingCount = useOutboxPendingCount(runtime.outbox);
  const clientOutOfDate = useServerBuildRef(runtime);
  const { revisionRunning, revisionJustLanded } = useRevisionActivity();
  const { deliberationStatus, deliberationQueuedCount, deliberationJustLanded, deliberationFailureReason } =
    useDeliberationActivity();
  return (
    <>
      {render(
        statusStripState({
          notConnectedToHome,
          pendingCount,
          clientOutOfDate,
          revisionRunning,
          revisionJustLanded,
          deliberationStatus,
          deliberationQueuedCount,
          deliberationJustLanded,
          deliberationFailureReason,
        }),
      )}
    </>
  );
}

/**
 * The strip has to say something before the runtime exists, and something
 * different if it never will. Both stay inside #42's rule that the strip is
 * neutral by default, yellow on exception and **never red** — a client that
 * cannot start is an exception, not a klaxon.
 */
const BOOTING_STRIP: StripState = { tone: "neutral", text: "starting…" };
const BOOT_FAILED_STRIP: StripState = {
  tone: "caution",
  text: "could not start · reload to retry",
};

/** Gives any consumer a strip regardless of boot state. */
function WithStrip({ render }: { readonly render: (strip: StripState) => ReactNode }) {
  const state = useRuntimeState();
  if (state.status === "ready") {
    return <LiveStrip runtime={state.runtime} render={render} />;
  }
  return <>{render(state.status === "failed" ? BOOT_FAILED_STRIP : BOOTING_STRIP)}</>;
}

/* ------------------------------------------------------------------ the shell */

/**
 * Which destination the chrome marks as current. Derived from the URL rather
 * than held in state, so a deep link, a reload and the back button all agree
 * with the chrome — the whole reason #42 wanted real routes.
 */
function destFor(pathname: string): Dest {
  if (pathname.startsWith("/plan")) return "plan";
  if (pathname.startsWith("/coach")) return "coach";
  if (pathname.startsWith("/settings")) return "settings";
  return "today";
}

/**
 * The four-destination chrome. `Shell` is used exactly as the prototype
 * settled it, with `active` computed from the location; the destinations
 * themselves are `<Link>`s to `DEST_PATHS` (#59 — they are real URLs, so
 * middle-click, open-in-new-tab and "link" being announced all work now).
 *
 * Coach's badge (story 36) is live, counting pending Proposals off
 * `subscribeProposals`. It is fed by a child component rather than read here
 * because the subscription needs a booted runtime, and the chrome renders
 * before there is one.
 */
function ShellRoute({ children }: { readonly children: ReactNode }) {
  const location = useLocation();
  const state = useRuntimeState();

  const shell = (strip: StripState, badges: ChromeBadges) => (
    <Shell active={destFor(location.pathname)} strip={strip} badges={badges}>
      {children}
    </Shell>
  );

  return (
    <WithStrip
      render={(strip) =>
        state.status === "ready" ? (
          <BadgedShell render={(badges) => shell(strip, badges)} />
        ) : (
          shell(strip, { coach: 0, coachPip: false })
        )
      }
    />
  );
}

/** Splits the Coach glyph's two subscriptions below the boot gate — see
 *  `LiveStrip`. The count (`subscribeProposals`) and the activity pip
 *  (`subscribeDeliberationRuns`) are independent signals (#150). */
function BadgedShell({ render }: { readonly render: (badges: ChromeBadges) => ReactNode }) {
  const coach = usePendingProposalCount();
  const coachPip = useCoachActivityPip();
  return <>{render({ coach, coachPip })}</>;
}

/**
 * Everything below this needs a booted runtime. Rendering the gate as a
 * component rather than a conditional inside each surface is what lets the
 * surfaces call `useRuntime()` unconditionally.
 */
function BootGate({
  children,
  fallback,
}: {
  readonly children: ReactNode;
  readonly fallback?: (state: Exclude<ReturnType<typeof useRuntimeState>, { status: "ready" }>) => ReactNode;
}) {
  const state = useRuntimeState();
  if (state.status === "ready") return <>{children}</>;
  if (fallback !== undefined) return <>{fallback(state)}</>;
  return state.status === "failed" ? (
    <SurfaceError title="Runtime failed to start" reason={state.cause} />
  ) : (
    <Placeholder title="Starting" />
  );
}

/* ------------------------------------------------------------------- surfaces */

function TodayRoute() {
  return (
    <ShellRoute>
      <BootGate>
        <TodaySurface />
      </BootGate>
    </ShellRoute>
  );
}

function TodaySurface() {
  const navigate = useNavigate();
  const planState = usePlan();
  // #147: reconcile the device-local Resume pointer against the server's
  // `active` sessions once connected — a browser that lost site data still
  // finds its in-flight workout.
  useInFlightReconciliation();
  const { inFlight, setInFlight } = useInFlightSession();
  const runtimeState = useRuntimeState();
  const [starting, setStarting] = useState<SessionId | undefined>(undefined);
  const [startError, setStartError] = useState<string | undefined>(undefined);

  const plan = planOf(planState);
  const nextUp = useNextUp(plan, inFlight?.loggedSessionId);

  if (plan === undefined) {
    return planState.status === "failed" ? (
      // Story 38: an honest error state rather than an empty surface.
      <SurfaceError title="Could not load your plan" reason={planState.reason} />
    ) : (
      <Placeholder title="Loading your plan" />
    );
  }

  // "No Plan yet" is the Intake invitation, and ADR 0014 §8 puts the offline
  // check on that door rather than inside the takeover.
  if (isEmptyPlan(plan) && inFlight === undefined) {
    return (
      <OfflineAwareEmptyState
        onIntake={() => navigate("/intake")}
        onManual={() => navigate("/plan")}
      />
    );
  }

  const start = (sessionId: SessionId) => {
    if (runtimeState.status !== "ready") return;
    setStarting(sessionId);
    setStartError(undefined);
    void startWorkout(runtimeState.runtime, sessionId).then(
      (session) => {
        setStarting(undefined);
        setInFlight(session);
        navigate(`/log/${encodeURIComponent(session.loggedSessionId)}`);
      },
      (cause: unknown) => {
        setStarting(undefined);
        setStartError(describeFailure(cause));
      },
    );
  };

  return (
    <Today
      plan={plan}
      stale={planState.status === "stale"}
      inFlight={inFlight}
      nextUp={nextUp}
      starting={starting}
      startError={startError}
      onResume={(session: InFlightSession) =>
        navigate(`/log/${encodeURIComponent(session.loggedSessionId)}`)
      }
      onStart={start}
      onPlan={() => navigate("/plan")}
      onHistory={() => navigate("/history")}
      onStats={() => navigate("/stats")}
      onProgress={() => navigate("/progress")}
    />
  );
}

/**
 * Today's empty state, with `offline` taken from the supervisor. Intake is the
 * single flow that cannot degrade gracefully — the app is local-first but
 * there is no local coach — so the invitation must not dangle a door that
 * dead-ends.
 */
function OfflineAwareEmptyState({
  onIntake,
  onManual,
}: {
  readonly onIntake: () => void;
  readonly onManual: () => void;
}) {
  const state = useRuntimeState();
  if (state.status !== "ready") {
    return <TodayEmptyState offline={false} onIntake={onIntake} onManual={onManual} />;
  }
  return <LiveEmptyState runtime={state.runtime} onIntake={onIntake} onManual={onManual} />;
}

function LiveEmptyState({
  runtime,
  onIntake,
  onManual,
}: {
  readonly runtime: RepCoachRuntime;
  readonly onIntake: () => void;
  readonly onManual: () => void;
}) {
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  return <TodayEmptyState offline={notConnectedToHome} onIntake={onIntake} onManual={onManual} />;
}

/* ----------------------------------------------------------------- the Plan */

function PlanRoute() {
  return (
    <ShellRoute>
      <BootGate>
        <PlanSurface />
      </BootGate>
    </ShellRoute>
  );
}

function PlanSurface() {
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const planState = usePlan();
  const plan = planOf(planState);

  if (plan === undefined) {
    return planState.status === "failed" ? (
      <SurfaceError title="Could not load your plan" reason={planState.reason} />
    ) : (
      <Placeholder title="Loading your plan" />
    );
  }
  return (
    <PlanEditorSurface
      plan={plan}
      snapshotSessionId={sessionId}
      onSelect={(next) => navigate(`/plan/${encodeURIComponent(next)}`)}
    />
  );
}

/**
 * Split from `PlanSurface` because `usePlanEditor` needs a Plan to exist, and
 * a hook cannot be called conditionally. The selected Session lives in the URL
 * (`/plan/:sessionId`), so the back button moves between days while authoring
 * (story 25).
 */
function PlanEditorSurface({
  plan,
  snapshotSessionId,
  onSelect,
}: {
  readonly plan: PlanSnapshot;
  readonly snapshotSessionId: string | undefined;
  readonly onSelect: (sessionId: SessionId) => void;
}) {
  const { notConnectedToHome } = useConnectionState(useRuntime().supervisor);
  const catalog = useExerciseCatalog(true);
  const catalogState = catalog.state;
  const editor = usePlanEditor(plan, catalogState.status === "ready" ? catalogState.exercises : []);

  const selectedId =
    snapshotSessionId === undefined
      ? editor.plan.sessions[0]?.id
      : (snapshotSessionId as SessionId);

  // The editor waits for the catalog rather than opening against an empty
  // one. `applyPlanOperation` validates `addEntry` against the authoring
  // context, so an edit made in the gap would be rejected as an unknown
  // exercise — and every name on screen would be a de-slugged guess. A
  // catalog that cannot be fetched is stated, not papered over.
  if (catalogState.status === "failed") {
    return <SurfaceError title="Could not load the exercise catalog" reason={catalogState.reason} />;
  }
  if (catalogState.status !== "ready") {
    return <Placeholder title="Loading the exercise catalog" />;
  }

  return (
    <Plan
      editor={editor}
      catalog={catalogState.exercises}
      authoring={{ create: catalog.create, rename: catalog.rename, offline: notConnectedToHome }}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

/* ---------------------------------------------------------------- the Coach */

function CoachRoute() {
  return (
    <ShellRoute>
      <BootGate>
        <CoachSurface />
      </BootGate>
    </ShellRoute>
  );
}

/**
 * The permanent record (#42, #79). Split from the route only so the
 * connection state can be read after the runtime has booted — the record is
 * online-only, and saying so is part of the surface (ADR 0002/0008).
 */
function CoachSurface() {
  const runtime = useRuntime();
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  return <Coach offline={notConnectedToHome} />;
}

/* ------------------------------------------------------------- the Settings */

function SettingsRoute() {
  return (
    <ShellRoute>
      <BootGate>
        <SettingsSurface />
      </BootGate>
    </ShellRoute>
  );
}

/** Split from the route only so the connection state can be read after the runtime has booted — same shape as `CoachSurface`. */
function SettingsSurface() {
  const runtime = useRuntime();
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  return <Settings offline={notConnectedToHome} />;
}

/* -------------------------------------------------------------- the history */

/**
 * History (issue #114 Part 2) — its own route off Today, not a fifth dock
 * destination (#42's settled IA stays at four). `destFor` below leaves it
 * marking "today" active in the chrome, since it is reached from there and
 * has no dock slot of its own to highlight.
 */
function HistoryRoute() {
  return (
    <ShellRoute>
      <BootGate>
        <HistorySurface />
      </BootGate>
    </ShellRoute>
  );
}

function HistorySurface() {
  const navigate = useNavigate();
  const runtime = useRuntime();
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  const state = useSessionHistory(!notConnectedToHome);
  return (
    <History
      offline={notConnectedToHome}
      state={state}
      onOpen={(loggedSessionId) => navigate(`/log/${encodeURIComponent(loggedSessionId)}`)}
    />
  );
}

/* ---------------------------------------------------------------- the stats */

/**
 * Stats (issue #117) — its own route off Today, same reasoning as History
 * immediately above: #42's IA stays at four, so `destFor` leaves this
 * marking "today" active too.
 */
function StatsRoute() {
  return (
    <ShellRoute>
      <BootGate>
        <StatsSurface />
      </BootGate>
    </ShellRoute>
  );
}

function StatsSurface() {
  const navigate = useNavigate();
  const runtime = useRuntime();
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  const state = useDailySetCounts(!notConnectedToHome);
  return (
    <Stats
      offline={notConnectedToHome}
      state={state}
      // A tapped day names the calendar date, not a Logged Session id — there
      // is no date-to-session lookup RPC, and adding one is out of this
      // ticket's scope (`getDailySetCounts` is a pure aggregate, by design).
      // Reusing the existing History route, unscoped, is what the ticket
      // means by "reuse the History route landing" when it merged.
      onOpenDay={() => navigate("/history")}
    />
  );
}

/* ------------------------------------------------------------- the progress */

/** Progress — off Today like History and Stats, so `destFor` marks "today". */
function ProgressRoute() {
  return (
    <ShellRoute>
      <BootGate>
        <ProgressSurface />
      </BootGate>
    </ShellRoute>
  );
}

function ProgressSurface() {
  const runtime = useRuntime();
  const { notConnectedToHome } = useConnectionState(runtime.supervisor);
  const state = useExerciseProgress(!notConnectedToHome);
  const catalog = useExerciseCatalog(!notConnectedToHome);
  const bodyweight = useBodyweight(!notConnectedToHome);
  return (
    <Progress
      offline={notConnectedToHome}
      state={state}
      catalog={catalog.state.status === "ready" ? catalog.state.exercises : []}
      bodyweight={bodyweight}
    />
  );
}

/* -------------------------------------------------------------- the logging */

/**
 * Logging is a **mode**: destination chrome suppressed on both shells, strip
 * kept (offline capture is the whole point), one back affordance to Today.
 */
function LogRoute() {
  return (
    <BootGate
      fallback={(state) => (
        <ModeShell>
          {state.status === "failed" ? (
            <SurfaceError title="Runtime failed to start" reason={state.cause} />
          ) : (
            <Placeholder title="Starting" />
          )}
        </ModeShell>
      )}
    >
      <LogSurface />
    </BootGate>
  );
}

function LogSurface() {
  const navigate = useNavigate();
  const { loggedSessionId } = useParams();
  const { clearInFlight } = useInFlightSession();
  // Display names only. Unlike the Plan editor this does NOT gate the surface:
  // logging has to work in a dead spot, and a de-slugged "Back Squat" is a
  // far smaller loss than a workout that will not open.
  const catalog = useExerciseCatalog(true);
  // Only for the after-finish "swap this in the plan?" prompt; never gates logging.
  const plan = planOf(usePlan());
  const { notConnectedToHome } = useConnectionState(useRuntime().supervisor);
  const {
    state,
    refresh,
    recordLocal,
    recordLocalUnlog,
    recordLocalNote,
    recordLocalNoteEdit,
    recordLocalSwap,
    forgetLocalSwap,
  } = useLoggedSession(
    (loggedSessionId ?? "") as LoggedSessionId,
  );

  if (state.status !== "ready") {
    return (
      <WithStrip
        render={(strip) => (
          <ModeShell strip={strip}>
            {state.status === "failed" ? (
              // Story 38 again, and the sharper case: a session that failed to
              // load must not present an empty grid the user might log into.
              <SurfaceError
                title="Could not open this session"
                reason={state.reason}
                onRetry={refresh}
              />
            ) : (
              <Placeholder title="Opening the session" />
            )}
          </ModeShell>
        )}
      />
    );
  }

  return (
    <WithStrip
      render={(strip) => (
        <Logging
          model={state.model}
          catalog={catalog.state.status === "ready" ? catalog.state.exercises : []}
          authoring={{ create: catalog.create, rename: catalog.rename, offline: notConnectedToHome }}
          strip={strip}
          onRecord={recordLocal}
          onUnlogged={recordLocalUnlog}
          onRecordNote={recordLocalNote}
          onRecordNoteEdit={recordLocalNoteEdit}
          onSwapped={recordLocalSwap}
          onSwapRejected={forgetLocalSwap}
          plan={plan}
          onExit={() => navigate("/")}
          onFinished={() => {
            clearInFlight();
            navigate("/");
          }}
          onCancelled={() => {
            clearInFlight();
            navigate("/");
          }}
        />
      )}
    />
  );
}

/* ------------------------------------------------------------------- intake */

/**
 * Intake is a mode too, and a harder one: chrome-free means the strip goes as
 * well, which is why this renders `ModeShell` without one (#74). No new shell
 * is introduced — `ModeShell` was built with Intake as one of its two named
 * consumers — and there is one column at every width.
 *
 * The takeover needs the runtime, because the whole surface is a live
 * deliberator session. Boot states are handled *before* entering it rather than
 * inside: discovering there is no coach after entering a chrome-free takeover
 * means the takeover exists only to apologise (ADR 0014 §8), which is also why
 * the unreachable-coach check lives on Today's empty state and not here.
 */
function IntakeRoute() {
  const navigate = useNavigate();
  const state = useRuntimeState();

  return (
    <ModeShell>
      {state.status === "ready" ? (
        <IntakeTakeover
          runtime={state.runtime}
          onAbandon={() => navigate("/")}
          onManual={() => navigate("/plan")}
          onAccepted={() => navigate("/")}
        />
      ) : (
        <IntakeDoorClosed
          failed={state.status === "failed"}
          onManual={() => navigate("/plan")}
          onBack={() => navigate("/")}
        />
      )}
    </ModeShell>
  );
}

/**
 * A deep link to `/intake` that arrives before the runtime does — or after it
 * failed. Stated as the constraint ("the coach runs on your home server")
 * rather than as the symptom, and never a dead end: the manual path is right
 * there, which is the same rule Today's empty state follows.
 */
function IntakeDoorClosed({
  failed,
  onManual,
  onBack,
}: {
  readonly failed: boolean;
  readonly onManual: () => void;
  readonly onBack: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 pt-8 pb-8 @2xl:px-8">
      <h1 className="text-xl leading-snug font-semibold tracking-tight">
        {failed ? "The coach can't be reached" : "Starting up"}
      </h1>
      <p className="mt-2 text-sm leading-normal text-text-muted">
        {failed
          ? "The coach runs on your home server, and this device can't get to it right now. You can still write the first plan yourself — that needs no agent at all."
          : "Connecting to your home server."}
      </p>
      {failed && (
        <div className="mt-5 flex gap-1.5">
          <button
            onClick={onManual}
            className="h-tap flex-[2] rounded-control bg-confirm px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider text-canvas uppercase"
          >
            Write the first plan myself
          </button>
          <button
            onClick={onBack}
            className="h-tap flex-1 rounded-control border border-border-strong px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider uppercase"
          >
            Back
          </button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------- routes */

export function App() {
  return (
    <div className="min-h-dvh bg-canvas">
      <Routes>
        <Route path="/" element={<TodayRoute />} />
        <Route path="/plan" element={<PlanRoute />} />
        <Route path="/plan/:sessionId" element={<PlanRoute />} />
        <Route path="/coach" element={<CoachRoute />} />
        <Route path="/coach/:proposalId" element={<CoachRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/history" element={<HistoryRoute />} />
        <Route path="/stats" element={<StatsRoute />} />
        <Route path="/progress" element={<ProgressRoute />} />
        <Route path="/log/:loggedSessionId" element={<LogRoute />} />
        <Route path="/intake" element={<IntakeRoute />} />
        {/* The static route SPA-falls-back, so an unknown deep link reaches the
            client rather than 404ing at the server. Landing is always Today
            (#42). */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
