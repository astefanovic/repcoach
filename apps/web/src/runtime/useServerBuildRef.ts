import { useEffect, useState } from "react";

import { RPC_METHODS } from "@repcoach/contracts";

import { isClientOutOfDate } from "./buildRef.ts";
import type { RepCoachRuntime } from "./RuntimeProvider.tsx";
import { callRpc } from "./rpc.ts";

/**
 * The client/server drift check (issue #111).
 *
 * **The failure this exists for.** The server runs the TypeScript source
 * through `tsx`; the browser is served a prebuilt Vite bundle from
 * `apps/web/dist`. Nothing rebuilt that bundle for two days, `TokenUsage` was
 * widened from `{prompt, completion}` to `{input, output, cacheRead,
 * cacheCreation}` in between, and every Intake then failed at the client's
 * schema decode of a perfectly good reply. The socket never dropped, the agent
 * ran and was billed in full, and the only thing on screen was "the coach lost
 * its connection partway through" — a sentence that sent the investigation to
 * the transport, which was healthy throughout.
 *
 * So the drift gets its own signal, at the top of the status strip, in red.
 * The point is not to explain the mismatch; it is to stop the user paying for
 * agent runs whose answers their bundle is going to throw away.
 *
 * **Why the commit and not the contract.** A hash scoped to
 * `packages/contracts` would fire only on changes that can actually break the
 * wire, and would stay quiet for a docs-only commit. The commit was chosen
 * instead: it catches every drift, including the ones a contracts-scoped hash
 * would miss (a client-side decode helper, a shared runtime module), at the
 * cost of firing after any commit that ships without a client rebuild. That
 * noise is the deliberate trade — see the UAT watchlist entry.
 */

/** What the build baked in. `"unknown"` if the build could not consult git. */
export const CLIENT_BUILD_REF: string = __BUILD_REF__;

/**
 * Asks the server once, on connect, which commit it is running.
 *
 * One shot rather than a subscription: the server's commit cannot change
 * without the process restarting, and a restart drops the socket and remounts
 * this anyway. A failed read leaves the answer `undefined` — the connection
 * state has its own, better-informed opinion about a server that will not
 * answer, and this must not add a second voice to it.
 */
export function useServerBuildRef(runtime: RepCoachRuntime): boolean {
  const [serverRef, setServerRef] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void callRpc(runtime, RPC_METHODS.serverGetConfig, {} as never)
      .then((result) => {
        const ref = (result as { readonly buildRef?: string }).buildRef;
        if (live && typeof ref === "string") setServerRef(ref);
      })
      .catch(() => {
        // Deliberately silent — see above.
      });
    return () => {
      live = false;
    };
  }, [runtime]);

  return isClientOutOfDate(CLIENT_BUILD_REF, serverRef);
}
