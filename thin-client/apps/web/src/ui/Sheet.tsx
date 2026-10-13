// The one modal idiom both surfaces use. Bottom sheet, because at
// 412px the bottom is the only place a list of choices is reachable one-handed.
// Card-less language, so it is a canvas panel fenced by a 2px top rule rather
// than an elevated surface.
import { useId, type ReactNode } from "react";

export function Sheet({
  title,
  onClose,
  children,
  header,
  tall = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Pinned under the title while the body scrolls — a search field, filters. */
  header?: ReactNode;
  /** Fixed at full sheet height, so a list that filters as you type does not make the sheet jump. */
  tall?: boolean;
}) {
  const titleId = useId();
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`${tall ? "h-[85%]" : "max-h-[85%]"} w-full max-w-md overflow-y-auto rounded-t-panel border-t-2 border-border-strong bg-canvas pb-[env(safe-area-inset-bottom)]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-canvas">
          <h2
            id={titleId}
            className="border-b border-border px-4 py-2.5 font-numeric text-[0.625rem] tracking-widest text-text-muted uppercase"
          >
            {title}
          </h2>
          {header}
        </div>
        {children}
        <button
          onClick={onClose}
          className="h-tap w-full font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase"
        >
          Close
        </button>
      </div>
    </div>
  );
}

export function SheetItem({
  label,
  hint,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  hint?: string;
  tone?: "danger";
  /** Visibly disabled with its hint stating why (e.g. a swap offered only before any Set is logged, ADR 0019) — never simply hidden. */
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-baseline gap-2 border-b border-border px-4 py-3 text-left active:bg-surface-sunken disabled:opacity-60"
    >
      <span className={`text-[0.9375rem] font-medium ${tone === "danger" ? "text-danger" : ""}`}>
        {label}
      </span>
      {hint && (
        <span className="ml-auto shrink-0 font-numeric text-[0.625rem] tracking-wide text-text-faint uppercase">
          {hint}
        </span>
      )}
    </button>
  );
}

/**
 * ±  stepper, the prototype's stand-in for a number input everywhere.
 *
 * `label` names *what* is being stepped, and it is not decoration (#82). The
 * set-group editor stacks five of these in one column — sets, reps, load, rest,
 * effort — and unlabelled they are five identical `Increase` buttons. A screen
 * reader user hears no more than that, and neither does an acceptance test,
 * which is how the gap was found: a rung-2 spec could not say "add two sets"
 * without resorting to positional indexing, i.e. to asserting DOM order.
 *
 * Optional rather than required because the single-stepper cases (a Block's
 * round count, a rest default) already have exactly one on screen, and there
 * `Increase` alone is unambiguous. `Logging.tsx` does the same thing inline for
 * its per-metric steppers.
 */
export function Stepper({
  value,
  step = 1,
  min = 0,
  suffix,
  label,
  nudge = (current, delta) => +(current + delta).toFixed(2),
  onChange,
}: {
  value: number;
  step?: number;
  min?: number;
  suffix?: string;
  label?: string;
  /** What one −/+ tap does to the value; plain addition unless the caller snaps (a lb load does). */
  nudge?: (current: number, delta: number) => number;
  onChange: (n: number) => void;
}) {
  const name = (verb: string) => (label === undefined ? verb : `${verb} ${label}`);
  return (
    <span className="inline-flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(min, nudge(value, -step)))}
        className="grid size-9 shrink-0 place-items-center rounded-control border border-border text-base"
        aria-label={name("Decrease")}
      >
        −
      </button>
      <span className="flex w-14 items-baseline justify-center">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          min={min}
          step={step}
          aria-label={label ?? "Value"}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            if (!Number.isNaN(n)) onChange(Math.max(min, n));
          }}
          className="w-9 shrink-0 bg-transparent text-center font-numeric text-base tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        {suffix && <span className="ml-0.5 shrink-0 text-[0.625rem] text-text-faint">{suffix}</span>}
      </span>
      <button
        onClick={() => onChange(nudge(value, step))}
        className="grid size-9 shrink-0 place-items-center rounded-control border border-border text-base"
        aria-label={name("Increase")}
      >
        +
      </button>
    </span>
  );
}
