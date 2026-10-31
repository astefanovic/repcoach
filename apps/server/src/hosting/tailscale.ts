import { spawn } from "node:child_process";
import * as fs from "node:fs";

/**
 * The few `tailscale` CLI calls the server needs, ported from t3code's
 * `@t3tools/tailscale` (and from what `Start-RepcoachServer.ps1` used to do in
 * PowerShell). Promise-based with an injectable runner so the decisions built
 * on top (`tailscaleExposure.ts`) are testable without a tailnet.
 *
 * Two rules carried over from t3code:
 *
 * - **Every call is bounded.** `tailscale serve` blocks forever when the
 *   tailnet has not enabled HTTPS certificates; `tailscale status` takes ~2 s
 *   on Windows. A call that runs out of time is killed and reported as such.
 * - **stderr is never surfaced raw.** It can carry auth keys and node names,
 *   and these results end up in logs and in Settings, so it is reduced to a
 *   named diagnostic.
 */

export const DEFAULT_SERVE_PORT = 443;
export const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";

const STATUS_TIMEOUT_MS = 6_000;
const SERVE_TIMEOUT_MS = 15_000;

export type TailscaleRun =
  | { readonly kind: "not-installed" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "exited"; readonly code: number; readonly stdout: string; readonly stderr: string };

export type TailscaleRunner = (args: ReadonlyArray<string>, timeoutMs: number) => Promise<TailscaleRun>;

const WINDOWS_DEFAULT_CLI = "C:\\Program Files\\Tailscale\\tailscale.exe";

const runOnce = (executable: string, args: ReadonlyArray<string>, timeoutMs: number): Promise<TailscaleRun> =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (run: TailscaleRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const child = spawn(executable, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      settle({ kind: "timed-out" });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (error: NodeJS.ErrnoException) =>
      settle(error.code === "ENOENT" ? { kind: "not-installed" } : { kind: "exited", code: -1, stdout, stderr: String(error) }),
    );
    child.on("close", (code) => settle({ kind: "exited", code: code ?? -1, stdout, stderr }));
  });

/** Runs the real CLI. On Windows a service context may not have Tailscale on PATH, so the default install path is tried too. */
export const nodeTailscaleRunner: TailscaleRunner = async (args, timeoutMs) => {
  const first = await runOnce(process.platform === "win32" ? "tailscale.exe" : "tailscale", args, timeoutMs);
  if (first.kind === "not-installed" && process.platform === "win32" && fs.existsSync(WINDOWS_DEFAULT_CLI)) {
    return runOnce(WINDOWS_DEFAULT_CLI, args, timeoutMs);
  }
  return first;
};

export type StderrDiagnostic = "not-logged-in" | "permission-denied" | "https-not-enabled" | "unknown";

export const stderrDiagnostic = (stderr: string): StderrDiagnostic | undefined => {
  if (stderr.trim() === "") return undefined;
  if (/not logged in|logged out|needs? login/i.test(stderr)) return "not-logged-in";
  if (/permission denied|access denied|must be root|operation not permitted/i.test(stderr)) return "permission-denied";
  if (/https.*(not enabled|disabled)|enable https|certificates/i.test(stderr)) return "https-not-enabled";
  return "unknown";
};

export interface TailscaleStatus {
  /** `Running`, `NeedsLogin`, `Stopped`, … */
  readonly backendState: string | null;
  readonly magicDnsName: string | null;
  /**
   * Whether the tailnet has HTTPS certificates enabled, which `tailscale serve
   * --https` needs. Read from the node's `https` capability (t3code) or, on
   * CLIs that do not report capabilities, a non-empty `CertDomains`.
   */
  readonly httpsEnabled: boolean;
}

export const parseTailscaleStatus = (json: string): TailscaleStatus => {
  const parsed = JSON.parse(json) as {
    readonly BackendState?: unknown;
    readonly CertDomains?: unknown;
    readonly Self?: { readonly DNSName?: unknown; readonly CapMap?: unknown };
  };
  const dns = typeof parsed.Self?.DNSName === "string" ? parsed.Self.DNSName.trim().replace(/\.$/, "") : "";
  const capMap = parsed.Self?.CapMap;
  const hasHttpsCap = typeof capMap === "object" && capMap !== null && Object.hasOwn(capMap, "https");
  const hasCertDomains = Array.isArray(parsed.CertDomains) && parsed.CertDomains.length > 0;
  return {
    backendState: typeof parsed.BackendState === "string" ? parsed.BackendState : null,
    magicDnsName: dns === "" ? null : dns,
    httpsEnabled: hasHttpsCap || hasCertDomains,
  };
};

/** The proxy target `tailscale serve` has for `/` on `<dns>:<port>`, or `null` if nothing is mapped there. */
export const parseServeProxy = (json: string, magicDnsName: string, servePort: number): string | null => {
  if (json.trim() === "") return null;
  const parsed = JSON.parse(json) as {
    readonly Web?: Record<string, { readonly Handlers?: Record<string, { readonly Proxy?: unknown }> }>;
  };
  const proxy = parsed.Web?.[`${magicDnsName}:${servePort}`]?.Handlers?.["/"]?.Proxy;
  return typeof proxy === "string" ? proxy : null;
};

export const serveTargetFor = (localPort: number): string => `http://127.0.0.1:${localPort}`;

export const httpsUrlFor = (magicDnsName: string, servePort: number = DEFAULT_SERVE_PORT): string =>
  servePort === DEFAULT_SERVE_PORT ? `https://${magicDnsName}/` : `https://${magicDnsName}:${servePort}/`;

export type StatusRead =
  | { readonly ok: true; readonly status: TailscaleStatus }
  | { readonly ok: false; readonly reason: "not-installed" | "timed-out" | "failed"; readonly detail?: StderrDiagnostic };

export const readTailscaleStatus = async (run: TailscaleRunner): Promise<StatusRead> => {
  const result = await run(["status", "--json"], STATUS_TIMEOUT_MS);
  if (result.kind === "not-installed") return { ok: false, reason: "not-installed" };
  if (result.kind === "timed-out") return { ok: false, reason: "timed-out" };
  // `tailscale status` exits non-zero when logged out but still prints JSON.
  try {
    return { ok: true, status: parseTailscaleStatus(result.stdout) };
  } catch {
    const detail = stderrDiagnostic(result.stderr);
    return { ok: false, reason: "failed", ...(detail === undefined ? {} : { detail }) };
  }
};

export const readServeProxy = async (
  run: TailscaleRunner,
  magicDnsName: string,
  servePort: number,
): Promise<string | null> => {
  const result = await run(["serve", "status", "--json"], STATUS_TIMEOUT_MS);
  if (result.kind !== "exited" || result.code !== 0) return null;
  try {
    return parseServeProxy(result.stdout, magicDnsName, servePort);
  } catch {
    return null;
  }
};

export type ServeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "timed-out" | "failed" | "not-installed"; readonly detail?: StderrDiagnostic };

/** `tailscale serve --bg --https=<port> http://127.0.0.1:<localPort>`. The mapping persists across reboots. */
export const ensureTailscaleServe = async (
  run: TailscaleRunner,
  localPort: number,
  servePort: number,
): Promise<ServeResult> => {
  const result = await run(["serve", "--bg", `--https=${servePort}`, serveTargetFor(localPort)], SERVE_TIMEOUT_MS);
  if (result.kind === "not-installed") return { ok: false, reason: "not-installed" };
  if (result.kind === "timed-out") return { ok: false, reason: "timed-out" };
  if (result.code === 0) return { ok: true };
  const detail = stderrDiagnostic(result.stderr);
  return { ok: false, reason: "failed", ...(detail === undefined ? {} : { detail }) };
};
