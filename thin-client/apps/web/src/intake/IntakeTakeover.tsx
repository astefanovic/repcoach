// The Intake takeover, on the real runner (#74).
//
// The visual and interaction design is NOT revisited here: it is settled in
// `docs/design/ui-surfaces.md` → Intake and demonstrated by the #64 reference
// build, whose presentation this keeps — the collapsed summary, the draft hero,
// the revision ledger, one open question, the chips, the provisional marker,
// the swept card. What changed is everything underneath: the canned script is a
// held-open deliberator session, the fake activity list is real tool events
// phrased by `@repcoach/client-runtime`, and the hand-built verdict tables are
// the sweep's actual disclosure.
//
// The rule this file is written to: **it renders, it does not decide**. Every
// derivation — phrasing, scoping, ledger lines, failure copy, the spend footer
// — comes from the `Intake` runtime module, because `apps/web` is excluded from
// vitest and a decision made in JSX is a decision nothing can assert on.
import { useRef, useState } from "react";

import { Intake } from "@repcoach/client-runtime";
import type { IntakeCitationVerdict, IntakeRationaleLine } from "@repcoach/contracts";

import { Sheet, SheetItem } from "../ui/Sheet.tsx";
import type { RepCoachRuntime } from "../runtime/RuntimeProvider.tsx";
import { useWeightUnit } from "../runtime/weightUnit.ts";
import { useIntakeSession, type IntakePhase } from "./useIntakeSession.ts";

export function IntakeTakeover({
  runtime,
  onAbandon,
  onManual,
  onAccepted,
}: {
  readonly runtime: RepCoachRuntime;
  readonly onAbandon: () => void;
  readonly onManual: () => void;
  readonly onAccepted: () => void;
}) {
  const [form, setForm] = useState<Intake.IntakeFormValues>(Intake.emptyIntakeForm);
  const [state, actions] = useIntakeSession(runtime, onAccepted);
  const [leaving, setLeaving] = useState(false);
  const weightUnit = useWeightUnit();

  // §8: confirm ONLY when there is something to lose, and "untouched" means
  // unchanged since the screen opened — not "equal to an empty form".
  const opened = useRef(form).current;
  const dirty = Intake.isIntakeTakeoverDirty(state.turn, form, opened);
  const leave = () => (dirty ? setLeaving(true) : onAbandon());

  const swept = state.converged;
  const plan = swept?.draftPlan ?? state.turn?.draftPlan;
  const rationale = swept?.rationale ?? state.turn?.rationale ?? [];
  const calibrationNote = swept?.calibrationNote ?? state.turn?.calibrationNote;
  const lookupCitation =
    swept !== undefined
      ? Intake.sweptCitations(swept)
      : state.turn !== undefined
        ? Intake.provisionalCitations(state.turn)
        : () => undefined;

  // The disclosure is read off the citations the plan carried WHEN IT WAS SENT
  // to be swept — never off the swept rationale, which has already dropped what
  // it removed, and never off a wider list, which would disclose removing
  // sources this user never saw.
  const verdicts =
    swept === undefined ? [] : Intake.scopeDisclosure(swept.disclosure, state.citationScope);

  const spendFooter = Intake.formatIntakeSpend(state.spend, state.model);

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col px-4 pb-8 @2xl:px-8">
      <TakeoverBar phase={state.phase} onLeave={leave} />

      {state.phase === "form" ? (
        <IntakeForm
          values={form}
          failure={state.formFailure}
          onChange={setForm}
          onSubmit={() => actions.start(form)}
          onManual={onManual}
        />
      ) : (
        <>
          {/* §4: the form COLLAPSED, not a caption added — it stays pinned for
              the rest of Intake as the thing the plan is answering to. */}
          <PinnedSummary text={Intake.summariseIntakeForm(form)} />

          {state.phase === "cold" ? (
            <ColdWait />
          ) : (
            plan !== undefined && (
              <>
                <DraftHero
                  headline={plan.headline}
                  sessions={Intake.draftSessionLines(plan, weightUnit)}
                  rationale={rationale}
                  revision={swept?.revision ?? state.turn?.revision ?? 1}
                  swept={swept !== undefined}
                  lookupCitation={lookupCitation}
                />

                {/* §7: the calibration note arrives WITH the draft, under the
                    hero, and survives into the accepted Decision — so it is
                    still here on the Proposal rather than swapped out for it. */}
                {calibrationNote !== undefined && <CalibrationNote text={calibrationNote} />}

                <RevisionLedger entries={state.ledger} />

                {state.phase === "proposal" || state.phase === "accepted" ? (
                  <ProposalCard
                    verdicts={verdicts}
                    accepted={state.phase === "accepted"}
                    acceptFailure={state.acceptFailure}
                    onAccept={actions.accept}
                    onReopen={actions.reopen}
                  />
                ) : state.phase === "sweeping" ? (
                  <SweepWait
                    lines={Intake.intakeActivityLines(state.events, {
                      citationCount: state.citationScope.length,
                    })}
                  />
                ) : (
                  <Exchange
                    question={state.turn?.openQuestion?.question}
                    options={state.turn?.openQuestion?.options ?? []}
                    pending={state.phase === "turn"}
                    turnFailure={state.turnFailure}
                    sweepFailure={state.sweepFailure}
                    onAnswer={actions.answer}
                    onConverge={actions.converge}
                    onManual={onManual}
                  />
                )}
              </>
            )
          )}

          {/* §4: spend gets ONE quiet provenance footer, accumulating across
              the held-open session — and only once a run has returned. */}
          {spendFooter !== undefined && (
            <p className="mt-auto pt-6 font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
              {spendFooter}
            </p>
          )}
        </>
      )}

      {leaving && (
        <Sheet title="Leave intake?" onClose={() => setLeaving(false)}>
          <p className="px-4 py-3 text-sm leading-normal text-text-muted">
            {state.turn !== undefined
              ? "The draft plan is gone — there is no saved copy and the coach's session ends with it. You'd start from the form again."
              : "Your answers are gone. Nothing has been saved."}
          </p>
          <SheetItem label="Leave, discard the draft" tone="danger" onClick={onAbandon} />
          <SheetItem label="Stay here" onClick={() => setLeaving(false)} />
        </Sheet>
      )}
    </div>
  );
}

/* ----------------------------------------------------------- the takeover bar */

/** The single back affordance — one word of chrome, no nav and no title bar. */
function TakeoverBar({ phase, onLeave }: { readonly phase: IntakePhase; readonly onLeave: () => void }) {
  return (
    <div className="flex items-center gap-2 pt-4 pb-1">
      <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
        {phase === "accepted" ? "plan created" : "first plan"}
      </span>
      {phase !== "accepted" && (
        <button
          onClick={onLeave}
          className="ml-auto font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase underline underline-offset-4"
        >
          Leave
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- the form */

function IntakeForm({
  values,
  failure,
  onChange,
  onSubmit,
  onManual,
}: {
  readonly values: Intake.IntakeFormValues;
  readonly failure: Intake.IntakeFailureMessage | undefined;
  readonly onChange: (values: Intake.IntakeFormValues) => void;
  readonly onSubmit: () => void;
  readonly onManual: () => void;
}) {
  const ready = Intake.isIntakeFormReady(values);

  return (
    <div>
      <h1 className="pt-2 text-2xl font-semibold tracking-tight">
        Four questions, then the coach writes you a plan
      </h1>
      <p className="mt-2 text-sm leading-normal text-text-muted">
        Only what it can't work out for itself. Everything that needs judgment, it'll ask you about
        once there's a real plan on the screen to argue with.
      </p>

      {/* §8: a failed cold draft returns HERE, with values intact. The
          statement sits above the form it is about, in caution yellow — a thing
          that did not work, not a thing that broke the app. Filled rather than
          ruled, because this one is the whole reason the screen came back. */}
      <Caution failure={failure} filled onManual={onManual} />

      <FormField label="What are you after" hint="required">
        <input
          value={values.goal}
          onChange={(event) => onChange({ ...values, goal: event.target.value })}
          placeholder="get stronger · put on size · stop hurting"
          className="h-tap w-full rounded-control border border-border-strong bg-surface px-3 text-[1.0625rem]"
        />
        {/* §1: deliberately un-validated. Sharpening a vague goal into measured
            targets is the coach's job, so saying so out loud is what stops the
            vagueness reading as a gap in the form. */}
        <p className="mt-1.5 text-xs leading-snug text-text-muted">
          Vague is fine. Sharpening this into numbers is the coach's job, not yours.
        </p>
      </FormField>

      <FormField label="Days a week" hint="required">
        <div className="flex flex-wrap gap-1.5">
          {Intake.INTAKE_DAYS_PER_WEEK.map((n) => (
            <Chip
              key={n}
              on={values.daysPerWeek === n}
              onClick={() => onChange({ ...values, daysPerWeek: n })}
            >
              {n}
            </Chip>
          ))}
        </div>
      </FormField>

      <FormField label="What you can train with">
        <div className="flex flex-wrap gap-1.5">
          {Intake.INTAKE_EQUIPMENT.map((item) => (
            <Chip
              key={item}
              on={values.equipment.includes(item)}
              onClick={() => onChange(Intake.toggleEquipment(values, item))}
            >
              {item}
            </Chip>
          ))}
        </div>
      </FormField>

      <FormField label="Current working weights" hint="skippable">
        <input
          value={values.lifts}
          onChange={(event) => onChange({ ...values, lifts: event.target.value })}
          placeholder="squat 100, bench 70 — or leave it blank"
          className="h-tap w-full rounded-control border border-border bg-surface px-3 text-[1.0625rem]"
        />
        <p className="mt-1.5 text-xs leading-snug text-text-muted">
          Skip it if you haven't been training. The coach will pick starting loads and correct them
          from your first week.
        </p>
      </FormField>

      <button
        onClick={onSubmit}
        disabled={!ready}
        className="mt-6 h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase disabled:opacity-40"
      >
        {failure === undefined ? "Draft my plan" : "Try again"}
      </button>
      <p className="mt-2 text-center font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
        Nothing is saved until you accept a plan
      </p>
    </div>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="mb-1.5 flex items-baseline gap-2 border-b border-border pb-1 font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
        {label}
        {hint && <span className="ml-auto text-text-faint">{hint}</span>}
      </h2>
      {children}
    </section>
  );
}

function Chip({
  on,
  onClick,
  children,
}: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`h-10 rounded-control border px-3 text-sm ${
        on ? "border-confirm bg-confirm font-semibold text-canvas" : "border-border text-text-muted"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------ pinned summary */

function PinnedSummary({ text }: { readonly text: string }) {
  return (
    // Sticky, because it is the premise the whole exchange is answering to and
    // it should still be readable four revisions down.
    <div className="sticky top-0 z-10 -mx-4 border-b border-border bg-canvas px-4 py-2 @2xl:-mx-8 @2xl:px-8">
      <p className="font-numeric text-[0.6875rem] tracking-wide text-text-muted">
        <span className="text-text-faint">you said</span> {text}
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- the waits */

/**
 * The cold wait (§4) — the worst moment in the app.
 *
 * It carries **no activity list and no progress bar**, and the absence is
 * deliberate rather than unfinished: `intake.events` is keyed on the session
 * id, and `intake.start` is what mints it, so no subscriber can exist while the
 * cold draft is being written. Inventing lines to fill that gap would be the
 * fake progress bar §4 exists to reject, so the wait says what it is doing in
 * words and shows a pulse — and nothing it cannot stand behind.
 */
function ColdWait() {
  return (
    <div className="pt-8">
      <h1 className="text-xl leading-snug font-semibold tracking-tight">Writing your first plan</h1>
      <p className="mt-1.5 text-sm leading-normal text-text-muted">
        It reads before it writes, so this takes a minute. You'll get the whole thing at once, and
        then you can argue with it.
      </p>
      <p className="mt-6 border-l-2 border-border pl-3.5 py-1 font-numeric text-[0.8125rem] leading-snug">
        <Pulse />
        reading, then drafting — nothing is saved until you accept a plan
      </p>
    </div>
  );
}

/**
 * The sweep wait (§5) — the second and last wait, and the one worth showing.
 * "The coach verifies every citation behind this plan" is the most
 * trust-building sentence the app will ever display, and it is true.
 *
 * Past lines STAY, dimmed. One string mutating in place is a spinner with extra
 * words, which is exactly the failure §4 names, and a growing list is the only
 * thing that gives the wait texture when one retrieval step runs long.
 */
function SweepWait({ lines }: { readonly lines: ReadonlyArray<Intake.IntakeActivityLine> }) {
  return (
    <div className="mt-6 border-t-2 border-border-strong pt-4">
      <h2 className="text-lg leading-snug font-semibold tracking-tight">
        Checking every source behind this plan
      </h2>
      <p className="mt-1.5 text-sm leading-normal text-text-muted">
        The sets and reps you settled on don't change. What can change is the reasoning underneath
        them — anything that doesn't hold up gets removed, and you'll see what went.
      </p>
      <ul className="mt-5 border-l-2 border-border pl-3.5">
        {lines.map((line, index) => (
          <li
            key={line.seq}
            className={`py-1 font-numeric text-[0.8125rem] leading-snug ${
              index === lines.length - 1 ? "text-text" : "text-text-faint"
            }`}
          >
            {index === lines.length - 1 ? (
              <Pulse />
            ) : (
              <span className="mr-2 text-text-ghost">·</span>
            )}
            {line.text}
          </li>
        ))}
        {lines.length === 0 && (
          <li className="py-1 font-numeric text-[0.8125rem] leading-snug">
            <Pulse />
            collecting every claim in the plan
          </li>
        )}
      </ul>
    </div>
  );
}

function Pulse() {
  return (
    <span className="mr-2 inline-block size-1.5 animate-pulse rounded-full bg-confirm align-middle" />
  );
}

/* ----------------------------------------------------------------- the hero */

function DraftHero({
  headline,
  sessions,
  rationale,
  revision,
  swept,
  lookupCitation,
}: {
  readonly headline: string;
  readonly sessions: ReadonlyArray<Intake.DraftSessionLine>;
  readonly rationale: ReadonlyArray<IntakeRationaleLine>;
  readonly revision: number;
  readonly swept: boolean;
  readonly lookupCitation: Intake.IntakeCitationLookup;
}) {
  return (
    <section className="pt-4">
      <div className="flex items-baseline gap-2">
        <h1 className="min-w-0 flex-1 text-xl leading-snug font-semibold tracking-tight">
          {headline}
        </h1>
        {/* The cheapest possible "this is the same object, changed" signal —
            and the reason four turns don't read as four messages. */}
        <span className="shrink-0 font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
          {swept ? "verified" : `draft ${revision}`}
        </span>
      </div>

      <ul className="mt-3">
        {sessions.map((session) => (
          <li key={session.label} className="border-b border-border py-2">
            <span className="block text-[0.9375rem] leading-tight font-medium">{session.label}</span>
            <span className="mt-0.5 block font-numeric text-xs leading-snug text-text-muted">
              {session.body}
            </span>
          </li>
        ))}
      </ul>

      <h3 className="mt-4 font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
        Why this shape
      </h3>
      <ul className="mt-1 border-l border-border pl-3.5">
        {rationale.map((line) => {
          const citation = lookupCitation(line.citationId);
          return (
            <li
              key={line.text}
              className="border-b border-border py-2 text-sm leading-snug last:border-0"
            >
              {line.text}
              {citation !== undefined && <Citation citation={citation} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------- citations */

/**
 * §3: interim citations are kept and marked provisional — hiding the coach's
 * reasoning at the moment the user is deciding whether to argue with it is the
 * worse failure, so the marking has to turn the pending sweep into a VISIBLE
 * PROMISE instead.
 *
 * ADR 0014 says "tooltip". This is tap-to-reveal, because a phone has no hover
 * and a `title=` on a 412px touch surface is a promise nobody can collect. The
 * promise is the whole feature; it cannot live in an interaction the target
 * device does not have.
 */
function Citation({ citation }: { readonly citation: Intake.IntakeCitationView }) {
  const [open, setOpen] = useState(false);

  if (citation.status === "provisional") {
    return (
      <>
        <button
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="ml-1 align-baseline font-numeric text-[0.5625rem] font-semibold tracking-widest text-deviation uppercase underline decoration-dotted underline-offset-2"
        >
          [provisional]
        </button>
        {open && (
          <span className="mt-1.5 block border-l-2 border-deviation/50 py-1 pl-2.5">
            <span className="block font-numeric text-[0.6875rem] leading-snug text-text-muted">
              {citation.source_url}
            </span>
            <span className="mt-1 block font-numeric text-[0.625rem] leading-snug tracking-wide text-deviation uppercase">
              not checked yet — every source gets verified when you review the plan
            </span>
          </span>
        )}
      </>
    );
  }

  if (citation.status === "removed") {
    // §5 step 2: the source is gone, so the line it backed is marked
    // reasoning-only rather than quietly losing its support.
    return (
      <span className="mt-1 block font-numeric text-[0.625rem] tracking-wide text-deviation uppercase">
        reasoning only — uncited
      </span>
    );
  }

  return (
    <>
      <span
        className={`ml-1 font-numeric text-[0.5625rem] font-semibold tracking-widest uppercase ${
          citation.trust === "corpus-verified" ? "text-evidence-strong" : "text-deviation"
        }`}
      >
        [{citation.trust}]
      </span>
      <span className="mt-1 block font-numeric text-[0.6875rem] leading-snug text-text-faint">
        {citation.source_url}
      </span>
    </>
  );
}

/* ------------------------------------------------------- the calibration note */

function CalibrationNote({ text }: { readonly text: string }) {
  // §7: not before the form (nobody reads expectation-setting before they have
  // seen anything), not a dismissable toast (putting the honest-disclosure
  // principle behind an "OK" is the one treatment that contradicts its own
  // content), and framed rather than floated so it reads as part of the plan.
  return (
    <section className="mt-5 border-l-2 border-border-strong bg-surface-sunken/60 py-3 pl-3.5">
      <h3 className="font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
        Calibration phase · first ~4 weeks
      </h3>
      <p className="mt-1.5 text-sm leading-normal">{text}</p>
    </section>
  );
}

/* ---------------------------------------------------------- revision ledger */

/** Answered turns fold beneath the draft. The line is what CHANGED; what you said is kept but subordinate. */
function RevisionLedger({ entries }: { readonly entries: ReadonlyArray<Intake.IntakeLedgerEntry> }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  return (
    <section className="mt-5">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-2 border-b border-border pb-1 font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase"
      >
        <span className="w-3 text-left">{open ? "▾" : "▸"}</span>
        How this draft got here
        <span className="text-text-faint">{entries.length}</span>
        {!open && (
          <span className="ml-auto truncate text-left tracking-normal normal-case text-text-faint">
            {entries[0]!.changed}
          </span>
        )}
      </button>
      {open && (
        <ul>
          {entries.map((entry) => (
            <li key={entry.revision} className="border-b border-border py-2">
              <span className="flex items-baseline gap-2">
                <span className="shrink-0 font-numeric text-[0.5625rem] tracking-widest text-text-faint uppercase">
                  draft {entry.revision}
                </span>
                <span className="min-w-0 flex-1 text-sm leading-snug">{entry.changed}</span>
              </span>
              <span className="mt-1 block font-numeric text-[0.6875rem] leading-snug text-text-faint">
                you answered: {entry.answer}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------- the exchange */

/** Exactly ONE open question is ever on screen, attached to the draft above it. */
function Exchange({
  question,
  options,
  pending,
  turnFailure,
  sweepFailure,
  onAnswer,
  onConverge,
  onManual,
}: {
  readonly question: string | undefined;
  readonly options: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly turnFailure: Intake.IntakeFailureMessage | undefined;
  readonly sweepFailure: Intake.IntakeFailureMessage | undefined;
  readonly onAnswer: (text: string) => void;
  readonly onConverge: () => void;
  readonly onManual: () => void;
}) {
  const [text, setText] = useState("");

  const send = (value: string) => {
    if (!Intake.isIntakeAnswerSubmittable(value)) return;
    setText("");
    onAnswer(value.trim());
  };

  return (
    <section className="mt-6 border-t-2 border-border-strong pt-3">
      <h3 className="font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase">
        {question === undefined ? "Nothing else to ask" : "The coach asks"}
      </h3>
      <p className="mt-1.5 text-[1.0625rem] leading-snug">
        {question ??
          "That's everything I need. Change anything else you want, or have me check the sources."}
      </p>

      {/* §2: a chip is an ANSWER, not a second channel — tapping it submits the
          same turn it would have typed. So the chips sit inside the input's own
          block and disappear with the question they answer. */}
      {options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option}
              disabled={pending}
              onClick={() => send(option)}
              className="h-10 rounded-control border border-border-strong px-3 text-sm disabled:opacity-40"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="mt-3 flex gap-1.5">
        <input
          value={text}
          disabled={pending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && send(text)}
          placeholder={options.length > 0 ? "…or say it yourself" : "Tell the coach what to change"}
          aria-label={question ?? "Tell the coach what to change"}
          className="h-tap min-w-0 flex-1 rounded-control border border-border bg-surface px-3 text-[1.0625rem] disabled:opacity-50"
        />
        <button
          onClick={() => send(text)}
          disabled={pending || !Intake.isIntakeAnswerSubmittable(text)}
          className="h-tap shrink-0 rounded-control border border-border-strong px-4 font-numeric text-[0.6875rem] font-semibold tracking-wider uppercase disabled:opacity-40"
        >
          Send
        </button>
      </div>

      {/* §4: the turn wait is gentle — the draft stays, the input disables, a
          quiet pending line sits under it. No lock ceremony and no per-turn
          Cancel, because Cancel here means abandoning Intake, which is free. */}
      {pending && (
        <p className="mt-2 font-numeric text-[0.6875rem] tracking-wide text-text-muted">
          <Pulse />
          the coach is revising the draft
        </p>
      )}

      <Caution failure={turnFailure} onManual={onManual} />
      <Caution failure={sweepFailure} onManual={onManual} />

      {/* §5: convergence is a SEPARATE act from acceptance, and the sweep sits
          between them. The label names the stage and the actor. */}
      <button
        onClick={onConverge}
        disabled={pending}
        className="mt-5 h-tap w-full rounded-control bg-confirm px-4 font-numeric text-xs font-semibold tracking-widest text-canvas uppercase disabled:opacity-40"
      >
        {sweepFailure === undefined ? "Review the sources" : "Check the sources again"}
      </button>
      <p className="mt-1.5 text-center font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
        Ends the back-and-forth · the coach verifies every source before you accept
      </p>
    </section>
  );
}

/**
 * Every §8 failure reads as caution, never as an error — same treatment
 * everywhere, which is the point: one component, so no failure site can drift
 * into looking like a crash. `filled` is the only variation, and it is weight
 * rather than meaning.
 */
function Caution({
  failure,
  filled = false,
  onManual,
}: {
  readonly failure: Intake.IntakeFailureMessage | undefined;
  readonly filled?: boolean;
  readonly onManual: () => void;
}) {
  if (failure === undefined) return null;
  return (
    <div
      className={
        filled
          ? "mt-4 border-l-2 border-deviation bg-deviation-quiet/40 py-2.5 pl-3"
          : "mt-2 border-l-2 border-deviation py-1 pl-2.5"
      }
    >
      <p className="font-numeric text-[0.625rem] tracking-widest text-deviation uppercase">
        {failure.heading}
      </p>
      <p className="mt-1 text-sm leading-snug">{failure.text}</p>
      {failure.offerManualPath && (
        <button
          onClick={onManual}
          className="mt-1.5 font-numeric text-[0.625rem] tracking-wider text-text-muted uppercase underline underline-offset-4"
        >
          Write the first plan myself →
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------------------- the Proposal card */

/**
 * §6: this is the ORDINARY Proposal card — accepting the first plan here
 * doubles as the tutorial for every coach Proposal the user will ever meet on
 * Today. Two cold-start divergences, both forced: the payload is the whole Plan
 * rather than a diff (rendered by `DraftHero` above, which is why this card
 * starts at the disclosure), and it is never pending on Today.
 */
function ProposalCard({
  verdicts,
  accepted,
  acceptFailure,
  onAccept,
  onReopen,
}: {
  readonly verdicts: ReadonlyArray<IntakeCitationVerdict>;
  readonly accepted: boolean;
  readonly acceptFailure: string | undefined;
  readonly onAccept: () => void;
  readonly onReopen: () => void;
}) {
  const summary = Intake.summariseDisclosure(verdicts);

  return (
    <section className="mt-6">
      <div className="flex items-baseline gap-2 border-t-2 border-border-strong pt-2.5">
        <span className="font-numeric text-[0.625rem] font-semibold tracking-widest text-accent uppercase">
          [Proposal]
        </span>
        <span className="font-numeric text-[0.625rem] tracking-widest text-text-faint uppercase">
          your first plan
        </span>
        <span className="ml-auto font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
          sources checked
        </span>
      </div>

      {/* §5 step 2: the card DISCLOSES ITS OWN EDITS — the feature working in
          public, on the exact surface where the user decides whether to trust
          the thing at all. Stated flatly, with the reason, and without a single
          apologetic word: yellow is caution, and caution is what this is. */}
      <div className="mt-3 border-l-2 border-deviation py-2 pl-3">
        <h3 className="font-numeric text-[0.625rem] tracking-widest text-deviation uppercase">
          What checking the sources changed
        </h3>
        <p className="mt-1.5 text-sm leading-snug">{summary.statement}</p>
        <ul className="mt-2">
          {summary.removed.map((verdict) => (
            <li key={verdict.citationId} className="border-t border-border py-1.5">
              <span className="block font-numeric text-[0.6875rem] leading-snug text-text-faint line-through">
                {verdict.source_url}
              </span>
              {/* §5: a removal without its reason is a worthless disclosure, so
                  a verdict that arrives without one says that rather than
                  rendering an empty row under a struck-through source. */}
              <span className="block text-xs leading-snug text-text-muted">
                {verdict.why ?? "no reason was given for this removal"}
              </span>
            </li>
          ))}
        </ul>
        {/* The load-bearing sentence: what was NOT touched. Shown only when
            something was struck through — otherwise it denies an accusation
            nobody made. */}
        {summary.prescriptionUntouched && (
          <p className="mt-2 font-numeric text-[0.625rem] leading-relaxed tracking-wide text-text-muted uppercase">
            The sets and reps you settled on are unchanged. Only the reasoning was edited.
          </p>
        )}
        {summary.gutted && (
          <p className="mt-2 text-sm leading-snug">
            That leaves this plan standing on less than I'd like. It is still the plan you and I
            agreed on and it is still worth running — you just now know exactly how much of it is
            evidence and how much is my judgment.
          </p>
        )}
      </div>

      {acceptFailure !== undefined && (
        <p className="mt-3 border-l-2 border-deviation py-1 pl-2.5 text-sm leading-snug">
          {acceptFailure}
        </p>
      )}

      {accepted ? (
        <p className="mt-5 border-t border-border pt-3 text-center font-numeric text-[0.6875rem] tracking-widest text-confirm uppercase">
          Plan created · opening Today
        </p>
      ) : (
        <div className="mt-5 flex gap-1.5">
          {/* Red, and only now. An interim draft is not a proposal, so this is
              the first moment in Intake that earns the accent colour. */}
          <button
            onClick={onAccept}
            className="h-tap flex-[2] rounded-control bg-accent px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider text-on-accent uppercase"
          >
            Accept — this is my plan
          </button>
          {/* §5: the exchange stays reopenable; finishing again re-sweeps. */}
          <button
            onClick={onReopen}
            className="h-tap flex-1 rounded-control border border-border-strong px-3 font-numeric text-[0.6875rem] font-semibold tracking-wider uppercase"
          >
            Keep tweaking
          </button>
        </div>
      )}
    </section>
  );
}
