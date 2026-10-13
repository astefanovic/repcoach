// The Coach destination (#42, #79): the **permanent record** — now a record of
// the coach's DELIBERATION RUNS rather than a flat list of what they said.
//
// #42 split one feed into two surfaces, and the split is what this file has to
// honour. Today carries what is still owed a decision, and an item leaves
// Today the moment it is decided. Nothing ever leaves Coach — a Proposal you
// accepted in March is still here in July, still expandable, still showing the
// evidence it was accepted on. That is the whole point of a record: the coach
// cannot quietly revise its own history, because the history is a surface.
//
// So there are no actions here. Accept/Dismiss/Revise live on the undecided
// item on Today; offering them again on the record would be offering to decide
// something twice.
//
// ## Why runs, and not Decisions
//
// A list of Decisions can only ever show the runs that said something, and the
// two states worth seeing most are the other two. A run that read the data and
// judged that nothing cleared the bar is the anti-twitchy mechanism working
// (ADR 0011 §4) — and it wrote no rows, so on a list of Decisions it looked
// exactly like a coach that never ran. A run that died took its reason with it
// when the server restarted, so "quiet" and "crashing" read identically the
// next morning. A coach whose restraint is indistinguishable from its absence
// is not a coach anybody can calibrate their trust against.
//
// So the unit here is the run: one rail, newest at the top, each node coloured
// by outcome, opening into the two stages it is made of (deliberator →
// adversarial sweep) and the Decisions that came out the far end. The run in
// flight is the top node, which is what makes watching the coach work and
// reading what it did afterwards one list instead of two.
//
// Tokens, model and cost are deliberately absent. They are Settings' spend
// section, which asks what the coach costs; this surface asks how it reasoned,
// and putting a token count on it would turn an explainability surface into a
// telemetry one.
//
// Presentation of a Decision's working is `coachItem.tsx`, shared with Today's
// card, so an item reads identically in both places.
import { useEffect, useState } from "react";

import type {
  DecisionKind,
  DecisionStatus,
  DeliberationRunDecision,
  DeliberationRunRecord,
} from "@repcoach/contracts";

import { seenThrough } from "../runtime/coachActivity.ts";
import { useCoachLastSeen } from "../runtime/coachLastSeen.ts";
import { useDecisionWorking } from "../runtime/useDecisionWorking.ts";
import { useDeliberationRuns } from "../runtime/useDeliberationRuns.ts";
import {
  Kind,
  Provenance,
  Working,
  cadenceLabel,
  formatDay,
  formatSpan,
  plural,
} from "./coachItem.tsx";

export function Coach({ offline }: { readonly offline: boolean }) {
  const history = useDeliberationRuns();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  // Opening the record clears the Coach glyph's activity pip (#150) — and so
  // does a run landing while the record is on screen, since it is right there
  // at the top of the rail. Marking "seen through" the newest settled run
  // (rather than through `now`) means a strictly newer run still re-lights it,
  // with no dependence on client/server clock agreement.
  const { markSeen } = useCoachLastSeen();
  const runsForSeen = history.status === "ready" ? history.runs : undefined;
  useEffect(() => {
    if (runsForSeen === undefined) return;
    markSeen(seenThrough(runsForSeen, new Date().toISOString()));
  }, [runsForSeen, markSeen]);

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-16">
      <h2 className="mt-6 flex items-baseline gap-2 border-b border-border-strong pb-1 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        Deliberations
        {history.status === "ready" && (
          <span className="text-text-faint">{plural(history.runs.length, "run")}</span>
        )}
      </h2>

      {/* The record is online-only (ADR 0002/0008) and says so rather than
          presenting the last thing it happened to receive as current. The
          strip already carries the connection state; this is the surface
          admitting what that means for what is on it. */}
      {offline && (
        <Notice>
          Not connected to home —{" "}
          {history.status === "ready"
            ? "this record may be out of date."
            : "the record lives on the home server and cannot be read from here."}
        </Notice>
      )}

      {/* Not while offline: a subscription that cannot connect is not
          "loading", and a spinner that will never finish is a lie about what
          is happening. The line above already said what is wrong. */}
      {history.status === "loading" && !offline && <Notice>Loading the record…</Notice>}

      {history.status === "failed" && <Notice>Could not load the record — {history.reason}</Notice>}

      {history.status === "ready" && history.staleReason !== undefined && (
        <Notice>Lost the live connection — showing what was received.</Notice>
      )}

      {history.status === "ready" &&
        (history.runs.length === 0 ? (
          <Notice>
            Nothing yet. The coach writes here after it reviews a session — finish a workout and it
            will have something to say.
          </Notice>
        ) : (
          /* The rail: one continuous hairline, run nodes hung off it. */
          <ol className="relative mt-5 ml-2 border-l border-border pl-5">
            {history.runs.map((run) => (
              <RunNode
                key={run.runId}
                run={run}
                open={open.has(run.runId)}
                onToggle={() => toggle(run.runId)}
              />
            ))}
            <li className="relative pb-2">
              <Node tone="faint" />
              <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
                the record starts here
              </span>
            </li>
          </ol>
        ))}
    </div>
  );
}

function Notice({ children }: { readonly children: React.ReactNode }) {
  return <p className="mt-4 text-sm leading-snug text-text-muted">{children}</p>;
}

/**
 * The dot on the rail. Its colour is the run's outcome and nothing else.
 *
 * `quiet` — the run that said nothing — is a hollow ring rather than a
 * different colour, because it is not a lesser version of a run that spoke and
 * it is not a failure either. It is the coach declining to act, which is the
 * behaviour the whole Observation mechanism exists to produce.
 */
function Node({
  tone,
  pulse,
}: {
  readonly tone: "live" | "ok" | "quiet" | "bad" | "faint";
  readonly pulse?: boolean;
}) {
  const colour =
    tone === "live"
      ? "bg-confirm"
      : tone === "bad"
        ? "bg-danger"
        : tone === "quiet"
          ? "bg-canvas ring-1 ring-border-strong"
          : tone === "faint"
            ? "bg-border"
            : "bg-border-strong";
  return (
    <span
      className={`absolute top-1 -left-[1.4375rem] size-2 rounded-full ${colour} ${pulse ? "animate-pulse" : ""}`}
    />
  );
}

/**
 * What made this run happen, in the plainest words available.
 *
 * Derived from the cadence rather than stored. A trigger sentence with more in
 * it than this — which workout, how long ago — would have to be written at run
 * time and kept forever, and the cadence already carries everything the record
 * can honestly claim about why the coach woke up.
 */
const triggerLabel = (cadence: string): string =>
  cadence === "session-review"
    ? "after a finished workout"
    : cadence === "cycle-review"
      ? "on the monthly schedule"
      : cadence === "revision-run"
        ? "because you pushed back on a Proposal"
        : cadence === "intake"
          ? "at cold start"
          : "because you asked for a run";

/** The clock time a run started, beside its day — a rail of dates alone cannot separate two runs in one evening. */
const dayTime = (iso: string): string => {
  const date = new Date(iso);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${formatDay(iso)} ${hours}:${minutes}`;
};

function RunNode({
  run,
  open,
  onToggle,
}: {
  readonly run: DeliberationRunRecord;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const sessionsRead = run.dataWindow?.session_ids_considered.length ?? 0;
  const rawSpan = formatSpan(run.dataWindow?.window_from, run.dataWindow?.window_to);
  // A window that spans the day the run happened on says nothing the timestamp
  // beside it has not already said.
  const window = rawSpan === formatDay(run.startedAt) ? undefined : rawSpan;
  const tone =
    run.outcome === "running"
      ? "live"
      : run.outcome === "failed"
        ? "bad"
        : run.decisions.length === 0
          ? "quiet"
          : "ok";

  const meta = [
    sessionsRead > 0 ? `${sessionsRead} read` : undefined,
    window,
    run.dataWindow === undefined ? undefined : `roster ${run.dataWindow.evidence_roster_version}`,
    open ? "hide" : "open",
  ].filter((part) => part !== undefined);

  return (
    <li className="relative pb-6">
      <Node tone={tone} pulse={run.outcome === "running"} />

      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full text-left active:bg-surface-sunken"
      >
        <span className="flex items-baseline gap-2">
          <span className="font-numeric text-[0.625rem] font-semibold tracking-widest uppercase">
            {cadenceLabel(run.cadence)}
          </span>
          <span className="font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
            {dayTime(run.startedAt)}
          </span>
        </span>
        <span className="mt-0.5 block text-sm leading-snug">
          {run.outcome === "running" ? (
            <span className="text-confirm">Deliberating now, {triggerLabel(run.cadence)}.</span>
          ) : run.outcome === "failed" ? (
            <span className="text-danger">
              Failed{run.failureReason === undefined ? "" : `: ${run.failureReason}`}
            </span>
          ) : run.decisions.length === 0 ? (
            <span className="text-text-muted">
              Read {plural(sessionsRead, "session")}, said nothing
            </span>
          ) : (
            <span className="font-semibold">
              {plural(run.decisions.length, "decision")}{" "}
              <span className="ml-1 font-normal text-text-muted">
                {run.decisions.map((decision) => kindLabel(decision.kind)).join(", ")}
              </span>
            </span>
          )}
        </span>
        <span className="mt-0.5 block font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
          {meta.join(" · ")}
        </span>
      </button>

      {open && (
        <div className="mt-3">
          <Stages run={run} />

          {run.revisionProse !== undefined && (
            <blockquote className="mt-3 border-l-2 border-accent/40 pl-3 text-sm leading-snug text-text-muted italic">
              “{run.revisionProse}”
            </blockquote>
          )}

          {/* The two states that have no output to show, said out loud. A node
              that opened onto nothing would leave the user to guess which of
              "it found nothing" and "it broke" had happened. */}
          {run.outcome === "committed" && run.decisions.length === 0 && (
            <p className="mt-3 text-sm leading-snug text-text-muted">
              Both stages ran. Nothing cleared the bar for a change, so nothing was recorded.
            </p>
          )}

          {run.outcome === "failed" && (
            <p className="mt-3 text-sm leading-snug text-text-muted">
              Nothing was recorded and your plan is unchanged.
            </p>
          )}

          {run.decisions.map((decision) => (
            <Emitted key={decision.decisionId} decision={decision} />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * The stages the run is made of (ADR 0011 §1) — the deliberator drafting, the
 * adversarial sweep rewriting.
 *
 * Rendered as a chain rather than a checklist because the order is the claim:
 * the sweep's output *is* the committed Decision, so a Decision that reached
 * the record went through it. Absent entirely for a run reconstructed from
 * older Decisions, which has no record of its stages and does not pretend to.
 */
function Stages({ run }: { readonly run: DeliberationRunRecord }) {
  if (run.stages.length === 0) return null;
  return (
    <ol className="flex flex-wrap items-center gap-1.5 font-numeric text-[0.625rem] tracking-wide uppercase">
      {run.stages.map((stage, index) => (
        <li key={stage.stage} className="flex items-center gap-1.5">
          {index > 0 && <span className="text-text-faint">→</span>}
          <span
            className={`rounded-control px-1.5 py-0.5 ${
              stage.state === "done"
                ? "bg-surface-sunken text-text-muted"
                : stage.state === "running"
                  ? "bg-confirm-quiet text-confirm"
                  : // Struck through only once the run is over: on a live run
                    // this stage has not happened YET, and striking it would
                    // say it never will.
                    run.outcome === "running"
                    ? "text-text-faint"
                    : "text-text-faint line-through"
            }`}
          >
            {stage.stage}
          </span>
        </li>
      ))}
    </ol>
  );
}

const kindLabel = (kind: string): string =>
  kind === "proposal" ? "proposal" : kind === "answer" ? "answer" : "observation";

/**
 * What came out of the run — a compact panel, not a headline.
 *
 * The working stays behind its own disclosure, fetched on expand through
 * `decisions.get` (ADR 0011 §5 freezes it, so there is nothing to stream and
 * no reason for a rail of runs to carry every run's citations). Two levels of
 * disclosure rather than one, because the questions are different: opening a
 * run asks what it did, opening a Decision asks how it got there.
 */
function Emitted({ decision }: { readonly decision: DeliberationRunDecision }) {
  const [open, setOpen] = useState(false);
  const workingState = useDecisionWorking(decision.decisionId, open);
  const working = workingState.status === "ready" ? workingState.working : undefined;

  return (
    <article className="mt-3 rounded-panel bg-surface-sunken/60 p-3">
      <span className="flex items-baseline gap-2">
        <Kind tone={decision.kind === "proposal" ? undefined : "muted"}>
          {decision.kind === "proposal"
            ? "Proposal"
            : decision.kind === "answer"
              ? "Answer"
              : "Observation"}
        </Kind>
        <span className="ml-auto">
          <Status status={decision.status} kind={decision.kind} />
        </span>
      </span>
      <p className="mt-1 text-[0.9375rem] leading-snug font-semibold">{decision.summary}</p>
      <button
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="mt-1 font-numeric text-[0.625rem] tracking-wide text-accent uppercase underline underline-offset-2"
      >
        {open ? "hide working" : "show working"}
      </button>
      {open && (
        <div className="mt-1">
          <Working state={workingState} />
          <Provenance working={working} />
        </div>
      )}
    </article>
  );
}

/**
 * What became of this item — the half of the record Today cannot show, because
 * Today only ever holds things nothing has become of yet.
 *
 * `applied` and `accepted` read as done; `rejected` and `superseded` are
 * neutral rather than negative. Dismissing a Proposal is a legitimate outcome
 * the coach is meant to learn from (ADR 0008 retains it as context), so the
 * record must not render it as a failure.
 */
function Status({
  status,
  kind,
}: {
  readonly status: DecisionStatus;
  readonly kind: DecisionKind;
}) {
  const label =
    status === "applied" || status === "accepted"
      ? "accepted — applied to your plan"
      : status === "rejected"
        ? "dismissed"
        : status === "superseded"
          ? "superseded by a later version"
          : status === "escalated"
            ? "escalated into a proposal"
            : status === "expired"
              ? "closed — stale or contradicted"
              : status === "answered"
                ? "answered"
                : status === "open"
                  ? kind === "observation"
                    ? "open — no action proposed"
                    : "open"
                  : status === "pending"
                    ? "awaiting your decision on Today"
                    : status;
  const done = status === "applied" || status === "accepted";
  return (
    <span
      className={`font-numeric text-[0.625rem] tracking-wide uppercase ${
        done ? "text-confirm" : "text-text-muted"
      }`}
    >
      {label}
    </span>
  );
}
