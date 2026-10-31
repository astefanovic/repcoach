/**
 * The client/server drift rule (issue #111), on its own, with no build-time
 * global and no React in sight.
 *
 * Split from `useServerBuildRef.ts` for the reason `statusStrip.ts` is split
 * from the shell: rung 1 runs `environment: "node"` with no DOM and no Vite
 * `define`, so a rule sitting next to `__BUILD_REF__` — or inside a
 * `useEffect` — is a rule no test can reach. This file holds the decision; the
 * hook beside it holds the plumbing.
 */

/** The value both sides use when git could not be consulted. */
export const UNKNOWN_BUILD_REF = "unknown";

/**
 * Whether the served bundle and the server it is talking to came from
 * different commits.
 *
 * **Silence beats a false alarm.** An unresolved ref on either side means the
 * check has no evidence — a build made outside a git checkout is a legitimate
 * thing to do, and it must not present as a broken client. `undefined` is
 * "the server has not answered yet", which is likewise not a mismatch: the
 * strip would otherwise flash red on every page load before settling.
 *
 * The consequence is that this check is quiet exactly when it cannot be sure,
 * which is the property that makes people believe it when it does fire.
 */
export function isClientOutOfDate(
  clientRef: string,
  serverRef: string | undefined,
): boolean {
  if (serverRef === undefined) return false;
  if (clientRef === UNKNOWN_BUILD_REF || serverRef === UNKNOWN_BUILD_REF) return false;
  return clientRef !== serverRef;
}
