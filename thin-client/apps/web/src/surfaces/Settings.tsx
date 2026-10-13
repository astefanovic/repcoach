// The Settings destination (#81) — the last of the four top-level surfaces
// #42 settled with no build behind it. Three things live here: a model
// selector per cadence that resolves one (ADR 0011 §4), the RPE capture
// control (#63), and a read of the run ledger's spend (ADR 0011 §8
// amendment).
//
// Settings apply immediately — no save button, per #81's "this surface reads
// like the rest of the app rather than growing a save button the others do
// not have." Every control writes through `useSettings` on change.
import { useEffect, useState } from "react";

import { Units } from "@repcoach/client-runtime";

import type {
  AvailableModel,
  DeliberationCadence,
  DeliberationEffort,
  GetSpendSummaryResult,
  RpeCaptureMode,
  TokenUsage,
} from "@repcoach/contracts";

import {
  readNotificationPermission,
  requestNotificationPermission,
  showRestNotification,
} from "../platform/restNotifier.ts";
import { downloadDataExport } from "../runtime/commands.ts";
import { useRestTimerNotifyPreference } from "../runtime/restNotifyPreference.ts";
import { describeFailure } from "../runtime/rpc.ts";
import { useRuntime } from "../runtime/RuntimeProvider.tsx";
import { setPlateSetup, usePlateSetup } from "../runtime/plateSetup.ts";
import { setWeightUnit, useWeightUnit } from "../runtime/weightUnit.ts";
import { WorkoutImportSection } from "./WorkoutImport.tsx";
import { CONFIGURABLE_CADENCES, useSettings, type CadenceModelState } from "../runtime/useSettings.ts";

/**
 * The model list is READ, not authored (issue #81 follow-up).
 *
 * The first build hard-coded three model ids here, on the reasoning that the
 * contract should not enumerate models. The contract still does not — but the
 * Agent SDK on the home server already knows which models THIS installation's
 * signed-in account can run, and which of them honour an effort level, so the
 * client asks (`settings.listModels`) instead of guessing. A hand-authored
 * list goes stale the week a model ships and can offer models the account has
 * no access to.
 *
 * "Custom…" stays regardless: it is the escape hatch when the catalog cannot
 * be read at all, and for an id the SDK does not list but the account can
 * still run.
 */
const CUSTOM_MODEL = "__custom__";

const NO_EFFORT = "__default__";

/**
 * Offered only when the catalog does not say which levels a model takes — an
 * unlisted "Custom…" id, or a listed model that reports effort support without
 * enumerating levels. The SDK ignores a level the model does not honour, so
 * offering the full range there is the honest unknown rather than a promise.
 */
const ALL_EFFORT_LEVELS: ReadonlyArray<DeliberationEffort> = ["low", "medium", "high", "xhigh", "max"];

const CADENCE_LABEL: Record<DeliberationCadence, string> = {
  "session-review": "Session review",
  "cycle-review": "Cycle review",
  intake: "Intake",
  "on-demand": "On-demand",
  "revision-run": "Revision run",
};

const CADENCE_DESCRIPTION: Record<DeliberationCadence, string> = {
  "session-review": "Fires when you finish a workout — frequent, so a cheaper/faster model keeps it restrained.",
  "cycle-review": "Runs monthly, taking the longer history into account — rare enough to afford a stronger model.",
  intake: "The one interactive cold-start run — held open across your whole exchange with the coach.",
  "on-demand": "“Run now” — the same runner as Session review, triggered by hand.",
  "revision-run": "",
};

export function Settings({ offline }: { readonly offline: boolean }) {
  const settings = useSettings();

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-10">
      <h2 className="mt-6 border-b border-border-strong pb-1 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        Settings
      </h2>

      {/* Per-device, not per-account (#116 part 2) — this is a browser Notification
          permission, not a fact about the coach, so it lives outside the offline/ready
          gates below: it works (and matters) even when home is unreachable. First,
          because it is the one control used mid-workout, and it was easy to miss at
          the foot of the spend tables (UAT). */}
      <RestTimerNotifySection />
      <WeightUnitSection />
      <PlatesSection />

      {offline && (
        <p className="mt-4 text-sm leading-snug text-text-muted">
          Not connected to home — settings live on the home server and cannot be read or changed from here.
        </p>
      )}

      {!offline && settings.state.status === "loading" && (
        <p className="mt-4 text-sm leading-snug text-text-muted">Loading settings…</p>
      )}

      {!offline && settings.state.status === "failed" && (
        <p className="mt-4 text-sm leading-snug text-text-muted">
          Could not load settings — {settings.state.reason}
        </p>
      )}

      {!offline && settings.state.status === "ready" && (
        <>
          <ModelSection settings={settings} state={settings.state} />
          <RpeSection settings={settings} rpeMode={settings.state.rpeMode} />
          <SpendSection spend={settings.state.spend} />
        </>
      )}

      <DataSection offline={offline} />
    </div>
  );
}

/* --------------------------------------------------------- model selectors */

function ModelSection({
  settings,
  state,
}: {
  readonly settings: ReturnType<typeof useSettings>;
  readonly state: Extract<ReturnType<typeof useSettings>["state"], { status: "ready" }>;
}) {
  return (
    <section className="mt-6">
      <h3 className="text-[1.0625rem] leading-snug font-semibold">Model per cadence</h3>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        A cheaper/faster model for the frequent Session review, a stronger one for the rare Cycle review — every
        cadence that resolves a model at run time gets a selector.
      </p>

      {state.catalogUnavailableReason !== null && (
        <p className="mt-2 text-sm leading-snug text-text-muted">
          The model list could not be read from home — {state.catalogUnavailableReason} Choose “Custom…” to enter a
          model id by hand; anything already configured is still shown and still applies.
        </p>
      )}

      {CONFIGURABLE_CADENCES.map((cadence) => (
        <ModelRow
          key={cadence}
          cadence={cadence}
          current={state.models.get(cadence) ?? { model: null, effort: null }}
          catalog={state.catalog}
          onChange={(model, effort) => settings.setModel(cadence, model, effort)}
          error={settings.modelSaveErrors.get(cadence)}
        />
      ))}

      <div className="mt-4 border-t border-border pt-3">
        <span className="text-sm font-semibold">{CADENCE_LABEL["revision-run"]}</span>
        <p className="mt-1 text-sm leading-snug text-text-muted">
          Not configurable — a Revision run reads the Session review model (ADR 0013 §6), so arguing with the coach
          can never be the most expensive thing in the app.
        </p>
      </div>
    </section>
  );
}

function ModelRow({
  cadence,
  current,
  catalog,
  onChange,
  error,
}: {
  readonly cadence: DeliberationCadence;
  readonly current: CadenceModelState;
  readonly catalog: ReadonlyArray<AvailableModel>;
  readonly onChange: (model: string, effort: DeliberationEffort | undefined) => void;
  readonly error: string | undefined;
}) {
  const listed = catalog.find((model) => model.id === current.model);
  const isCustom = current.model !== null && listed === undefined;
  const [customText, setCustomText] = useState(isCustom ? current.model : "");
  const selectValue = current.model === null ? "" : isCustom ? CUSTOM_MODEL : current.model;

  // The effort control follows the SELECTED model, not a fixed list: a model
  // that honours no effort level gets no control rather than five options
  // that do nothing. An unlisted (custom) model is the honest unknown — the
  // SDK ignores a level it does not support, so the full range is offered and
  // the copy says the model decides.
  const effortLevels = listed?.effortLevels ?? [];
  const showEffort = isCustom || (listed !== undefined && listed.supportsEffort);
  const offeredLevels: ReadonlyArray<DeliberationEffort> =
    effortLevels.length > 0 ? effortLevels : ALL_EFFORT_LEVELS;

  const commitModel = (nextModel: string) => {
    if (nextModel.trim().length === 0) return;
    // Dropping an effort the newly-chosen model does not accept is the point
    // of reading the catalog: carrying `xhigh` from an Opus row onto a model
    // that tops out at `high` would persist a setting the run silently
    // ignores, which is exactly the half-wired control this change removes.
    const nextListed = catalog.find((model) => model.id === nextModel);
    const keepsEffort =
      current.effort !== null &&
      (nextListed === undefined
        ? true
        : nextListed.supportsEffort &&
          (nextListed.effortLevels.length === 0 || nextListed.effortLevels.includes(current.effort)));
    onChange(nextModel, keepsEffort ? (current.effort ?? undefined) : undefined);
  };

  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <label className="text-sm font-semibold" htmlFor={`model-${cadence}`}>
        {CADENCE_LABEL[cadence]}
      </label>
      {CADENCE_DESCRIPTION[cadence] !== "" && (
        <p className="text-sm leading-snug text-text-muted">{CADENCE_DESCRIPTION[cadence]}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          id={`model-${cadence}`}
          className="rounded border border-border-strong bg-transparent px-2 py-1 text-sm"
          value={selectValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === CUSTOM_MODEL) {
              if (customText.trim().length > 0) commitModel(customText);
              return;
            }
            commitModel(value);
          }}
        >
          <option value="" disabled>
            SDK default
          </option>
          {catalog.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
          {/* A configured model the catalog no longer lists still has to be
              selectable, or opening Settings would silently re-point the
              cadence at whatever the first option happens to be. */}
          <option value={CUSTOM_MODEL}>Custom…</option>
        </select>

        {selectValue === CUSTOM_MODEL && (
          <input
            aria-label={`Custom model id for ${CADENCE_LABEL[cadence]}`}
            className="rounded border border-border-strong bg-transparent px-2 py-1 text-sm"
            placeholder="model id"
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
            onBlur={() => commitModel(customText)}
          />
        )}

        {showEffort && (
          <>
            <label className="text-xs text-text-muted" htmlFor={`effort-${cadence}`}>
              Effort
            </label>
            <select
              id={`effort-${cadence}`}
              className="rounded border border-border-strong bg-transparent px-2 py-1 text-sm"
              value={current.effort ?? NO_EFFORT}
              onChange={(event) => {
                const value = event.target.value;
                if (current.model === null) return;
                onChange(current.model, value === NO_EFFORT ? undefined : (value as DeliberationEffort));
              }}
            >
              <option value={NO_EFFORT}>model default</option>
              {offeredLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {listed !== undefined && listed.description !== "" && (
        <p className="text-xs leading-snug text-text-muted">{listed.description}</p>
      )}
      {error !== undefined && <p className="text-xs text-danger">Could not save — {error}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- the RPE control */

const RPE_OPTIONS: ReadonlyArray<{ readonly mode: RpeCaptureMode; readonly label: string }> = [
  { mode: "off", label: "Off" },
  { mode: "flagged-only", label: "Flagged sets only" },
  { mode: "every-set", label: "Every set" },
];

function RpeSection({
  settings,
  rpeMode,
}: {
  readonly settings: ReturnType<typeof useSettings>;
  readonly rpeMode: RpeCaptureMode;
}) {
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <section className="mt-8 border-t border-border pt-4">
      <h3 className="flex items-center gap-1.5 text-[1.0625rem] leading-snug font-semibold">
        RPE capture
        <button
          type="button"
          aria-label="Why flagged sets only is the default"
          onClick={() => setInfoOpen((open) => !open)}
          className="rounded-full border border-border-strong px-1.5 text-xs text-text-muted"
        >
          i
        </button>
      </h3>
      {infoOpen && (
        <p className="mt-1 text-sm leading-snug text-text-muted">
          Flagged sets only is the default because it keeps the unflagged majority of your sets one-tap — RPE shows
          up only where the coach has already flagged a set worth a closer look (#63).
        </p>
      )}

      <div role="radiogroup" aria-label="RPE capture" className="mt-2 flex flex-col gap-1.5">
        {RPE_OPTIONS.map((option) => (
          <label key={option.mode} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="rpe-capture-mode"
              checked={rpeMode === option.mode}
              onChange={() => settings.setRpeMode(option.mode)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {settings.rpeSaveError !== undefined && (
        <p className="mt-1 text-xs text-danger">Could not save — {settings.rpeSaveError}</p>
      )}
    </section>
  );
}

/* --------------------------------------------------------- rest timer notify */

/**
 * The off-tab rest-timer toggle (#116 part 2). On by default: it only
 * changes anything once the browser has actually granted Notification
 * permission (`decideRestCompletionNotify` gates on that live), and vibrate
 * needs no permission at all, so an on-by-default toggle never surprises
 * anyone who has not been asked.
 *
 * UAT: the toggle alone could not tell "on" from "on, but the browser will
 * never show anything". It now says what the browser has granted, switching
 * it on asks for permission there and then (a tap is the user gesture the
 * prompt needs), and a test button proves the whole path on this phone
 * without waiting out a rest.
 */
function RestTimerNotifySection() {
  const { enabled, setEnabled } = useRestTimerNotifyPreference();
  const [permission, setPermission] = useState(readNotificationPermission);
  const supported = typeof Notification !== "undefined";

  // Permission can change behind the page's back (site settings), and the
  // user comes back from there by switching to the tab.
  useEffect(() => {
    const reread = () => setPermission(readNotificationPermission());
    document.addEventListener("visibilitychange", reread);
    return () => document.removeEventListener("visibilitychange", reread);
  }, []);

  const turn = (next: boolean) => {
    setEnabled(next);
    if (next && permission === "default") {
      void requestNotificationPermission().then(setPermission);
    }
  };

  const status = !supported
    ? "This browser cannot show notifications (on iPhone, only an app added to the Home Screen can)."
    : permission === "granted"
      ? "Notifications allowed."
      : permission === "denied"
        ? "Notifications are blocked for this site — allow them in the browser's site settings."
        : "Not asked yet — switching this on asks.";

  return (
    <section className="mt-4">
      <h3 className="text-[1.0625rem] leading-snug font-semibold">Rest timer notifications</h3>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        When rest ends while the app is in the background or the phone is locked, show a
        notification. Per device, so it is not a home-server setting.
      </p>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(event) => turn(event.target.checked)} />
        Notify when rest ends
      </label>
      <p className="mt-1 text-xs leading-snug text-text-muted" role="status">
        {status}
      </p>
      {supported && permission === "granted" && (
        <button
          onClick={() => void showRestNotification()}
          className="mt-2 rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken"
        >
          Send a test notification
        </button>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- weight unit */

/**
 * kg / lb (per device, `runtime/weightUnit.ts`). Display only: every stored
 * load stays kg, so flipping this rewrites nothing and the coach is
 * unaffected — which is also why it sits outside the offline gate.
 */
function WeightUnitSection() {
  const weightUnit = useWeightUnit();
  return (
    <section className="mt-8 border-t border-border pt-4">
      <h3 className="text-[1.0625rem] leading-snug font-semibold">Weight unit</h3>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        How loads are shown and typed on this device. Everything is stored in kilograms, so switching changes no
        numbers you have logged.
      </p>
      <div role="radiogroup" aria-label="Weight unit" className="mt-2 flex flex-col gap-1.5">
        {(
          [
            { unit: "kg", label: "Kilograms (kg)" },
            { unit: "lb", label: "Pounds (lb)" },
          ] as const
        ).map((option) => (
          <label key={option.unit} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="weight-unit"
              checked={weightUnit === option.unit}
              onChange={() => setWeightUnit(option.unit)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ plates */

/**
 * The bar and plates the plate calculator loads from (`runtime/plateSetup.ts`)
 * — per device, and per unit, in that unit: a lb gym's iron is not a kg gym's
 * converted. Edits apply on blur, like the custom model id above, so a
 * half-typed list never drives the calculator.
 */
function PlatesSection() {
  const weightUnit = useWeightUnit();
  const setup = usePlateSetup(weightUnit);
  const [bar, setBar] = useState(String(setup.bar));
  const [plates, setPlates] = useState(setup.plates.join(", "));

  // Follow the unit: switching kg to lb shows the lb setup.
  useEffect(() => {
    setBar(String(setup.bar));
    setPlates(setup.plates.join(", "));
  }, [setup]);

  const commitBar = () => {
    const parsed = Number(bar.replace(",", "."));
    if (Number.isFinite(parsed) && parsed >= 0) setPlateSetup(weightUnit, { ...setup, bar: parsed });
    else setBar(String(setup.bar));
  };
  const commitPlates = () => {
    const parsed = Units.parsePlateList(plates);
    if (parsed.length > 0) setPlateSetup(weightUnit, { ...setup, plates: parsed });
    else setPlates(setup.plates.join(", "));
  };

  return (
    <section className="mt-8 border-t border-border pt-4">
      <h3 className="text-[1.0625rem] leading-snug font-semibold">Plates</h3>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        What the plate calculator loads from, in {weightUnit}. It shows under a barbell load while you edit it, as
        the plates for each side.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="w-16 shrink-0">Bar</span>
          <input
            inputMode="decimal"
            value={bar}
            onChange={(event) => setBar(event.target.value)}
            onBlur={commitBar}
            aria-label="Bar weight"
            className="w-20 rounded border border-border-strong bg-transparent px-2 py-1 text-sm"
          />
          <span className="text-xs text-text-muted">{weightUnit}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-16 shrink-0">Plates</span>
          <input
            inputMode="decimal"
            value={plates}
            onChange={(event) => setPlates(event.target.value)}
            onBlur={commitPlates}
            aria-label="Plates on hand"
            className="min-w-0 flex-1 rounded border border-border-strong bg-transparent px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={() => setPlateSetup(weightUnit, Units.DEFAULT_PLATE_SETUP[weightUnit])}
          className="self-start text-xs text-text-muted underline underline-offset-4"
        >
          Reset to standard {weightUnit} plates
        </button>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- your data */

/**
 * "Export my data" — the whole home-server database as a JSON download. Last
 * on the page, and its own section rather than a line under spend: it is the
 * answer to "is my data mine", which a self-hosted app owes in plain sight.
 */
function DataSection({ offline }: { readonly offline: boolean }) {
  const runtime = useRuntime();
  const [state, setState] = useState<"idle" | "running" | { readonly error: string }>("idle");

  const exportNow = () => {
    setState("running");
    void downloadDataExport(runtime).then(
      () => setState("idle"),
      (cause: unknown) => setState({ error: describeFailure(cause) }),
    );
  };

  return (
    <section className="mt-8 border-t border-border pt-4 pb-4">
      <h3 className="text-[1.0625rem] leading-snug font-semibold">Your data</h3>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        Everything your home server holds — plan, every logged set, notes, and everything the coach has said — as
        one JSON file.
      </p>
      <button
        type="button"
        onClick={exportNow}
        disabled={offline || state === "running"}
        className="mt-2 rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken disabled:opacity-40"
      >
        {state === "running" ? "Preparing export…" : "Export my data (JSON)"}
      </button>
      {offline && (
        <p className="mt-1 text-xs leading-snug text-text-muted">Needs the home server — not connected.</p>
      )}
      {typeof state === "object" && <p className="mt-1 text-xs text-danger">Could not export — {state.error}</p>}
      <WorkoutImportSection offline={offline} />
    </section>
  );
}

/* ------------------------------------------------------------------- spend */

function SpendSection({ spend }: { readonly spend: GetSpendSummaryResult }) {
  return (
    <section className="mt-8 border-t border-border pt-4 pb-4">
      <h3 className="text-[1.0625rem] leading-snug font-semibold">Spend</h3>
      <p className="mt-1 text-sm leading-snug text-text-muted">
        Reporting, not control — cost is deliberately uncapped (ADR 0013, ADR 0014). Token counts from the Agent
        SDK, not a dollar bill (ADR 0005).
      </p>

      <h4 className="mt-4 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        By cadence
      </h4>
      {spend.perCadence.length === 0 ? (
        <p className="mt-1 text-sm leading-snug text-text-muted">No runs recorded yet.</p>
      ) : (
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-text-muted uppercase">
              <th className="pr-2 font-normal">Cadence</th>
              <th className="pr-2 font-normal">Runs</th>
              <th className="font-normal">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {spend.perCadence.map((row) => (
              <tr key={row.cadence}>
                <td className="pr-2">{CADENCE_LABEL[row.cadence]}</td>
                <td className="pr-2">{row.runCount}</td>
                <td>{formatTokens(row.usage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 className="mt-5 font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">
        Recent runs
      </h4>
      {spend.recentRuns.length === 0 ? (
        <p className="mt-1 text-sm leading-snug text-text-muted">Nothing yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {spend.recentRuns.map((run) => (
            <li key={run.runId} className="text-sm leading-snug">
              <span className="font-semibold">{CADENCE_LABEL[run.cadence]}</span>
              {" · "}
              {new Date(run.ranAt).toLocaleString()}
              {" · "}
              {run.model ?? "SDK default"}
              {" · "}
              {formatTokens(run.usage)} tokens
              {run.stages.length > 1 && (
                <span className="text-text-muted">
                  {" "}
                  ({run.stages.map((stage) => `${stage.stage} ${formatTokens(stage.usage)}`).join(", ")})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatTokens(usage: TokenUsage): string {
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheCreation;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k` : `${total}`;
}
