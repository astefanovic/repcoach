import { describe, expect, it } from "vitest";

import type { ServerIdentity } from "@repcoach/contracts";

import { parseServeProxy, parseTailscaleStatus, type TailscaleRun, type TailscaleRunner } from "./tailscale.ts";
import { TailscaleExposure, type IdentityProbe } from "./tailscaleExposure.ts";

const DNS = "homebox.tail1234.ts.net";
const URL_443 = `https://${DNS}/`;

const statusJson = (overrides: { backend?: string; https?: boolean } = {}): string =>
  JSON.stringify({
    BackendState: overrides.backend ?? "Running",
    Self: { DNSName: `${DNS}.`, CapMap: overrides.https === false ? {} : { https: null } },
  });

const serveJson = (proxy: string | null): string =>
  proxy === null ? "{}" : JSON.stringify({ Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: proxy } } } } });

const ok = (stdout: string): TailscaleRun => ({ kind: "exited", code: 0, stdout, stderr: "" });

/** A scripted tailscale CLI: `status`, `serve status` and `serve --bg` answers, recording what was run. */
const fakeTailscale = (script: {
  status: TailscaleRun;
  serveProxy?: string | null;
  serve?: TailscaleRun;
}): { run: TailscaleRunner; calls: Array<ReadonlyArray<string>> } => {
  const calls: Array<ReadonlyArray<string>> = [];
  let proxy = script.serveProxy ?? null;
  const run: TailscaleRunner = async (args) => {
    calls.push(args);
    if (args[0] === "status") return script.status;
    if (args[0] === "serve" && args[1] === "status") return ok(serveJson(proxy));
    const result = script.serve ?? ok("");
    if (result.kind === "exited" && result.code === 0) proxy = args[3] ?? null;
    return result;
  };
  return { run, calls };
};

const identity = (instanceId: string): ServerIdentity => ({
  app: "repcoach",
  instanceId,
  buildRef: "test",
  startedAt: new Date(0).toISOString(),
  phoneUrl: null,
});

const exposure = (run: TailscaleRunner, probe: IdentityProbe, enabled = true, targetAlive = true) =>
  new TailscaleExposure({
    run,
    localPort: 4020,
    instanceId: "me",
    enabled,
    probe,
    isTargetAlive: async () => targetAlive,
    sleep: async () => undefined,
    log: () => undefined,
  });

describe("tailscale CLI parsing", () => {
  it("reads the MagicDNS name and whether HTTPS certificates are on", () => {
    expect(parseTailscaleStatus(statusJson())).toEqual({ backendState: "Running", magicDnsName: DNS, httpsEnabled: true });
    expect(parseTailscaleStatus(statusJson({ https: false })).httpsEnabled).toBe(false);
    // Older CLIs without CapMap: CertDomains is the signal.
    expect(parseTailscaleStatus(JSON.stringify({ Self: { DNSName: DNS }, CertDomains: [DNS] })).httpsEnabled).toBe(true);
  });

  it("finds the proxy target for / on the serve port", () => {
    expect(parseServeProxy(serveJson("http://127.0.0.1:4020"), DNS, 443)).toBe("http://127.0.0.1:4020");
    expect(parseServeProxy("", DNS, 443)).toBeNull();
  });
});

describe("phone access", () => {
  it("sets up Serve when nothing is mapped, and proves it by reaching this instance", async () => {
    const tailscale = fakeTailscale({ status: ok(statusJson()) });
    const state = await exposure(tailscale.run, async () => identity("me")).check();
    expect(state).toEqual({ kind: "serving", url: URL_443 });
    expect(tailscale.calls).toContainEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:4020"]);
  });

  it("leaves an existing correct mapping alone", async () => {
    const tailscale = fakeTailscale({ status: ok(statusJson()), serveProxy: "http://127.0.0.1:4020" });
    expect(await exposure(tailscale.run, async () => identity("me")).check()).toEqual({ kind: "serving", url: URL_443 });
    expect(tailscale.calls.some((call) => call.includes("--bg"))).toBe(false);
  });

  it("never takes 443 from a target that is still running (the real server, seen from a commissioning run)", async () => {
    const tailscale = fakeTailscale({ status: ok(statusJson()), serveProxy: "http://127.0.0.1:4020" });
    const commissioning = new TailscaleExposure({
      run: tailscale.run,
      localPort: 4031,
      instanceId: "me",
      enabled: true,
      // An older server without the identity route: the probe learns nothing.
      probe: async () => null,
      isTargetAlive: async () => true,
      sleep: async () => undefined,
      log: () => undefined,
    });
    const state = await commissioning.check();
    expect(state.kind).toBe("taken");
    expect(tailscale.calls.some((call) => call.includes("--bg"))).toBe(false);
  });

  it("takes over a stale mapping whose target no longer answers", async () => {
    const tailscale = fakeTailscale({ status: ok(statusJson()), serveProxy: "http://127.0.0.1:9999" });
    let served = false;
    const probe: IdentityProbe = async () => (served ? identity("me") : null);
    const runner: TailscaleRunner = async (args, timeout) => {
      const result = await tailscale.run(args, timeout);
      if (args.includes("--bg")) served = true;
      return result;
    };
    expect(await exposure(runner, probe, true, false).check()).toEqual({ kind: "serving", url: URL_443 });
  });

  it("names the admin-console fix when HTTPS certificates are off, without running serve", async () => {
    const tailscale = fakeTailscale({ status: ok(statusJson({ https: false })) });
    const state = await exposure(tailscale.run, async () => null).check();
    expect(state.kind).toBe("https-disabled");
    expect(tailscale.calls.some((call) => call.includes("--bg"))).toBe(false);
  });

  it("reports a serve call that hangs (waiting on admin approval) as HTTPS being off", async () => {
    const tailscale = fakeTailscale({ status: ok(statusJson()), serve: { kind: "timed-out" } });
    expect((await exposure(tailscale.run, async () => null).check()).kind).toBe("https-disabled");
  });

  it("tells not-installed, logged-out and turned-off apart", async () => {
    expect((await exposure(async () => ({ kind: "not-installed" }), async () => null).check()).kind).toBe("not-installed");
    expect(
      (await exposure(fakeTailscale({ status: ok(statusJson({ backend: "NeedsLogin" })) }).run, async () => null).check()).kind,
    ).toBe("logged-out");
    expect((await exposure(async () => ({ kind: "not-installed" }), async () => null, false).check()).kind).toBe("disabled");
  });
});
