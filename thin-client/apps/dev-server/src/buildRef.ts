import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The git commit this server process is running (issue #111).
 *
 * The bug this exists for: the server runs the TypeScript **source** through
 * `tsx`, while the browser is served a prebuilt Vite bundle out of
 * `apps/web/dist`. Those two drift the moment the client is not rebuilt, and
 * nothing noticed — a `TokenUsage` widened two days earlier meant the server
 * returned a shape the served bundle could not decode, so every Intake died at
 * the client with "the coach lost its connection" while the socket stayed open
 * and the agent session was billed in full.
 *
 * So both halves now state which commit they came from and the client compares
 * them. The commit is read ONCE, at boot: it is a property of the running
 * process, and re-reading it per request would report a commit this process is
 * not actually running.
 *
 * **What this deliberately does not catch.** A dirty working tree is invisible
 * here — uncommitted edits do not move `HEAD`, and marking the ref `-dirty`
 * would fire on every session of ordinary development without telling anyone
 * anything they could act on. Editing without rebuilding is the *launcher's*
 * job to catch (`Start-RepcoachServer.ps1` compares the build's mtime against
 * the sources). This check answers the other question: are the running server
 * and the served bundle the same commit at all.
 */

const UNKNOWN_BUILD_REF = "unknown";

/**
 * `git rev-parse HEAD`, or `"unknown"`.
 *
 * Resolved against this file's own directory rather than `process.cwd()`,
 * because the production server is routinely launched from elsewhere (the
 * launcher `Set-Location`s to the workspace root, a service supervisor sets
 * whatever it likes) and the answer must be about the checkout the code was
 * loaded from.
 *
 * Never throws. A server that will not boot because git is missing would be a
 * far worse failure than one that cannot report its commit — the check degrades
 * to "cannot tell" and the app carries on.
 */
export const resolveServerBuildRef = (): string => {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ref = out.trim();
    return ref === "" ? UNKNOWN_BUILD_REF : ref;
  } catch {
    return UNKNOWN_BUILD_REF;
  }
};

/** Read once per process — see the note above on why this is not per-request. */
export const SERVER_BUILD_REF: string = resolveServerBuildRef();
