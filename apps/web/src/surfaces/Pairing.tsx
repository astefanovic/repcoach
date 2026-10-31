// Pairing: the screen an unpaired device sees, and `/pair`, where a pairing
// link lands. The home server only talks to devices that have redeemed a
// one-time code (`serverAuth.ts` on the server); this is the browser side.
import { useEffect, useRef, useState } from "react";

import type { PairingRefusal } from "@repcoach/contracts";

import { redeemPairingCode } from "../runtime/serverAccess.ts";

const REFUSAL_COPY: Record<PairingRefusal | "offline", string> = {
  malformed: "That link is incomplete. Copy the whole link, or scan the QR code again.",
  "bad-signature": "That link wasn't made by this server.",
  expired: "That link has expired — they last 15 minutes. Make a new one.",
  spent: "That link has already been used — each one pairs a single device. Make a new one.",
  offline: "Couldn't reach your home server. Check this device is on your tailnet, then try again.",
};

/** The pairing code and where to go after, from `/pair#code=…&next=…`. A fragment, so the code never reaches a server log. */
const readPairingFragment = (): { readonly code: string | null; readonly next: string } => {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const next = params.get("next");
  // Only same-origin paths: an open redirect on the pairing page would be a gift.
  return { code: params.get("code"), next: next !== null && next.startsWith("/") && !next.startsWith("//") ? next : "/" };
};

export function PairRoute() {
  const fragment = useRef(readPairingFragment());
  const [state, setState] = useState<"pairing" | { readonly failed: PairingRefusal | "offline" } | "no-code">(
    fragment.current.code === null ? "no-code" : "pairing",
  );

  useEffect(() => {
    const { code, next } = fragment.current;
    if (code === null) return;
    // Out of the address bar and history straight away; it is a credential until spent.
    window.history.replaceState(null, "", "/pair");
    let live = true;
    void redeemPairingCode(code).then((outcome) => {
      if (!live) return;
      // A full load rather than a client-side navigation, so the runtime
      // reconnects with the new cookie instead of waiting out its backoff.
      if (outcome.ok) window.location.replace(next);
      else setState({ failed: outcome.reason });
    });
    return () => {
      live = false;
    };
  }, []);

  if (state === "no-code") return <UnpairedScreen />;
  if (state === "pairing") {
    return (
      <PairingFrame title="Pairing this device…">
        <p className="mt-2 text-sm leading-normal text-text-muted">Checking the link with your home server.</p>
      </PairingFrame>
    );
  }
  return (
    <PairingFrame title="This device isn't paired">
      <p className="mt-2 text-sm leading-normal text-danger">{REFUSAL_COPY[state.failed]}</p>
      <HowToPair />
    </PairingFrame>
  );
}

export function UnpairedScreen({ onRecheck }: { readonly onRecheck?: () => void }) {
  return (
    <PairingFrame title="Pair this device">
      <p className="mt-2 text-sm leading-normal text-text-muted">
        Your home server only talks to devices you've paired with it. Pairing takes one scan, once per device.
      </p>
      <HowToPair />
      {onRecheck !== undefined && (
        <button
          type="button"
          onClick={onRecheck}
          className="mt-6 rounded-control border border-border px-3 py-1.5 text-sm active:bg-surface-sunken"
        >
          I've paired it — check again
        </button>
      )}
    </PairingFrame>
  );
}

function HowToPair() {
  return (
    <ol className="mt-5 flex list-decimal flex-col gap-3 pl-5 text-sm leading-normal">
      <li>
        On a device that's already paired, open <span className="font-semibold">Settings → Server</span> and tap{" "}
        <span className="font-semibold">Pair a device</span>. Scan the QR code with this device.
      </li>
      <li>
        Or, on the computer running RepCoach, run{" "}
        <code className="rounded bg-surface-sunken px-1 py-0.5 font-numeric text-xs">pnpm repcoach pair</code> and
        scan the QR code it prints.
      </li>
    </ol>
  );
}

function PairingFrame({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <div className="mx-auto max-w-xl px-4 pt-12 pb-10">
        <p className="font-numeric text-[0.6875rem] tracking-widest text-text-muted uppercase">RepCoach</p>
        <h1 className="mt-2 text-xl leading-snug font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  );
}
