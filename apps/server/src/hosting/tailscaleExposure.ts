import { SERVER_WELL_KNOWN_PATH, type PhoneAccessState, type ServerIdentity } from "@repcoach/contracts";

import {
  DEFAULT_SERVE_PORT,
  TAILSCALE_ADMIN_DNS_URL,
  ensureTailscaleServe,
  httpsUrlFor,
  readServeProxy,
  readTailscaleStatus,
  serveTargetFor,
  type TailscaleRunner,
} from "./tailscale.ts";

/**
 * Keeps the phone URL working: the server, not a launcher script, makes sure
 * `tailscale serve` fronts it over HTTPS, and re-checks every minute so a fix
 * made in the Tailscale admin console shows up without a restart.
 *
 * Differences from t3code's `--tailscale-serve`, both deliberate:
 *
 * - **The mapping is not removed on shutdown.** The phone has the URL
 *   bookmarked and installed as an app; a server restarting under its
 *   supervisor should not make that URL briefly belong to nothing.
 * - **There is no plain-http fallback.** An `http://` origin silently loses
 *   notifications, the wake lock and service workers. If Serve cannot be set
 *   up the server stays on loopback and says what to fix.
 *
 * **Success is proven by fetching the URL**, not by the CLI's exit code or by
 * reading back the config: the probe asks `/.well-known/repcoach/server` and
 * checks the `instanceId` is this process's. That is also how a second server
 * (a commissioning run on another port) knows 443 already belongs to a live
 * RepCoach and leaves it alone.
 */

export type IdentityProbe = (url: string) => Promise<ServerIdentity | null>;

const PROBE_TIMEOUT_MS = 3_000;
/** The first HTTPS request after `tailscale serve` can wait seconds for a certificate. */
const PROBE_ATTEMPTS = 6;
const PROBE_RETRY_MS = 1_000;

export const fetchIdentityProbe: IdentityProbe = async (url) => {
  try {
    const response = await fetch(new URL(SERVER_WELL_KNOWN_PATH, url), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ServerIdentity>;
    return body.app === "repcoach" && typeof body.instanceId === "string" ? (body as ServerIdentity) : null;
  } catch {
    return null;
  }
};

/** Whether anything answers HTTP at a serve target. Any response counts — only a refused or timed-out connection is "gone". */
export type TargetProbe = (target: string) => Promise<boolean>;

export const fetchTargetProbe: TargetProbe = async (target) => {
  try {
    await fetch(target, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
};

export interface TailscaleExposureOptions {
  readonly run: TailscaleRunner;
  readonly localPort: number;
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly servePort?: number;
  readonly probe?: IdentityProbe;
  readonly isTargetAlive?: TargetProbe;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
}

const describeDetail = (reason: string, detail?: string): string =>
  detail === undefined || detail === "unknown" ? reason : `${reason} (${detail})`;

export class TailscaleExposure {
  private current: PhoneAccessState = { kind: "checking" };
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<PhoneAccessState> | undefined;
  private readonly servePort: number;
  private readonly probe: IdentityProbe;
  private readonly isTargetAlive: TargetProbe;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(private readonly options: TailscaleExposureOptions) {
    this.servePort = options.servePort ?? DEFAULT_SERVE_PORT;
    this.probe = options.probe ?? fetchIdentityProbe;
    this.isTargetAlive = options.isTargetAlive ?? fetchTargetProbe;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // eslint-disable-next-line no-console
    this.log = options.log ?? ((line) => console.log(line));
  }

  get state(): PhoneAccessState {
    return this.current;
  }

  /** The https URL, once it is proven to reach this server. */
  get phoneUrl(): string | null {
    return this.current.kind === "serving" ? this.current.url : null;
  }

  /** One pass. Concurrent callers share the pass in flight. */
  check(): Promise<PhoneAccessState> {
    this.inFlight ??= this.evaluate().then(
      (next) => {
        this.inFlight = undefined;
        this.transition(next);
        return next;
      },
      (cause: unknown) => {
        this.inFlight = undefined;
        const next: PhoneAccessState = { kind: "failed", detail: String(cause) };
        this.transition(next);
        return next;
      },
    );
    return this.inFlight;
  }

  start(intervalMs: number = 60_000): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private transition(next: PhoneAccessState): void {
    const previous = this.current;
    this.current = next;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.log(`[repcoach-server] phone access: ${summarize(next)}`);
  }

  private async proveServing(url: string, attempts: number): Promise<"ours" | "other" | "nothing"> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const identity = await this.probe(url);
      if (identity !== null) return identity.instanceId === this.options.instanceId ? "ours" : "other";
      if (attempt < attempts - 1) await this.sleep(PROBE_RETRY_MS);
    }
    return "nothing";
  }

  private async evaluate(): Promise<PhoneAccessState> {
    if (!this.options.enabled) return { kind: "disabled" };
    const { run, localPort } = this.options;

    const read = await readTailscaleStatus(run);
    if (!read.ok) {
      if (read.reason === "not-installed") return { kind: "not-installed" };
      if (read.detail === "not-logged-in") return { kind: "logged-out" };
      return { kind: "not-running", detail: describeDetail(read.reason === "timed-out" ? "tailscale did not answer" : "tailscale status failed", read.detail) };
    }
    const { status } = read;
    if (status.backendState === "NeedsLogin" || status.backendState === "NoState") return { kind: "logged-out" };
    if (status.backendState !== null && status.backendState !== "Running") {
      return { kind: "not-running", detail: `Tailscale is ${status.backendState}` };
    }
    if (status.magicDnsName === null) {
      return { kind: "failed", detail: "This machine has no MagicDNS name. Enable MagicDNS for the tailnet." };
    }
    if (!status.httpsEnabled) {
      return { kind: "https-disabled", magicDnsName: status.magicDnsName, adminUrl: TAILSCALE_ADMIN_DNS_URL };
    }

    const url = httpsUrlFor(status.magicDnsName, this.servePort);
    const target = serveTargetFor(localPort);
    const proxy = await readServeProxy(run, status.magicDnsName, this.servePort);

    if (proxy === target) {
      const proven = await this.proveServing(url, this.current.kind === "serving" ? 2 : PROBE_ATTEMPTS);
      if (proven === "ours") return { kind: "serving", url };
      return { kind: "failed", detail: `Tailscale Serve points at this server, but ${url} does not answer from here.` };
    }

    if (proxy !== null) {
      // Something else is mapped. Take it over only if nothing answers at its
      // target any more: a live target is the owner's real server, this
      // server's commissioning twin, or an older RepCoach without the identity
      // route — none of which a second server should silently displace.
      if (await this.isTargetAlive(proxy)) {
        return { kind: "taken", url, detail: `${url} already points at ${proxy}, which is still running.` };
      }
      this.log(`[repcoach-server] tailscale serve on :${this.servePort} pointed at ${proxy}, which is not answering — taking it over.`);
    }

    const serve = await ensureTailscaleServe(run, localPort, this.servePort);
    if (!serve.ok) {
      if (serve.detail === "https-not-enabled" || serve.reason === "timed-out") {
        // Serve blocks waiting on an admin approval when certificates are off.
        return { kind: "https-disabled", magicDnsName: status.magicDnsName, adminUrl: TAILSCALE_ADMIN_DNS_URL };
      }
      return { kind: "failed", detail: describeDetail("tailscale serve failed", serve.detail) };
    }
    const proven = await this.proveServing(url, PROBE_ATTEMPTS);
    return proven === "ours"
      ? { kind: "serving", url }
      : { kind: "failed", detail: `tailscale serve was configured, but ${url} does not answer yet.` };
  }
}

export const summarize = (state: PhoneAccessState): string => {
  switch (state.kind) {
    case "checking":
      return "checking…";
    case "disabled":
      return "Tailscale Serve is turned off (REPCOACH_TAILSCALE_SERVE=0) — this server is reachable on this machine only.";
    case "not-installed":
      return "Tailscale is not installed — install it on this machine and your phone to reach the server from the phone.";
    case "not-running":
      return `${state.detail}. Start Tailscale on this machine.`;
    case "logged-out":
      return "Tailscale is logged out on this machine. Run `tailscale up`.";
    case "https-disabled":
      return `HTTPS certificates are off for this tailnet. Turn them on at ${state.adminUrl} — checked again every minute.`;
    case "taken":
      return state.detail;
    case "failed":
      return state.detail;
    case "serving":
      return `open ${state.url} on your phone`;
  }
};
