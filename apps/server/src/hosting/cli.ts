import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";

import { SERVER_WELL_KNOWN_PATH, type ServerIdentity } from "@repcoach/contracts";

import {
  dataDirFor,
  exitOnSignals,
  productionConfigFromEnv,
  serviceManagerFor,
  startProductionServer,
  type ProductionConfig,
} from "./productionMain.ts";
import { readRuntimeState, type RuntimeState } from "./runtimeState.ts";
import { mintPairingCode, readOrCreateServerSecret } from "./serverAuth.ts";

/**
 * `pnpm repcoach <command>` — the one entry point for running the home server.
 *
 *   install  Build the web client if needed, start the server (or reuse the
 *            running one), and open Settings in this machine's browser, already
 *            paired. Settings shows phone access and the "Install as background
 *            service" button.
 *   start    Build if needed and run the server in the foreground. What the
 *            background service runs. `--open` also opens Settings.
 *   pair     Print a one-time pairing QR code and link for another device.
 *   status   Is it running, where can the phone reach it, is the service installed.
 */

const WEB_DIR = fileURLToPath(new URL("../../../web", import.meta.url));

const say = (line = ""): void => {
  // eslint-disable-next-line no-console
  console.log(line);
};

const fail = (message: string): never => {
  // eslint-disable-next-line no-console
  console.error(`[repcoach] ${message}`);
  process.exit(1);
};

const assertNodeSqlite = async (): Promise<void> => {
  try {
    await import("node:sqlite");
  } catch {
    fail(`This Node (${process.version}) has no node:sqlite builtin — RepCoach needs Node 22.16 or newer.`);
  }
};

/**
 * Rebuilds the web client when it is missing or older than anything it is
 * built from (issue #111: a `dist` built at any point in the past used to boot
 * happily forever while the server moved on). Moved here from
 * `Start-RepcoachServer.ps1` so every platform and the background service get
 * it. Fails safe: a scan that cannot read the sources rebuilds.
 */
const newestSourceAfter = (roots: ReadonlyArray<string>, builtAt: number): string | undefined => {
  const stack = roots.filter((root) => fs.existsSync(root));
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      const name = path.basename(current);
      if (name === "node_modules" || name === "dist") continue;
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else if (stat.mtimeMs > builtAt) {
      return current;
    }
  }
  return undefined;
};

const webBuildStaleness = (): string | undefined => {
  const index = path.join(WEB_DIR, "dist", "index.html");
  if (!fs.existsSync(index)) return "no build yet";
  try {
    const newer = newestSourceAfter(
      [
        path.join(WEB_DIR, "src"),
        path.join(WEB_DIR, "public"),
        path.join(WEB_DIR, "index.html"),
        path.join(WEB_DIR, "vite.config.ts"),
        path.join(WEB_DIR, "..", "..", "packages"),
      ],
      fs.statSync(index).mtimeMs,
    );
    return newer === undefined ? undefined : `${path.basename(newer)} is newer than the build`;
  } catch (cause) {
    return `could not compare the build against its sources (${String(cause)})`;
  }
};

const ensureWebBuild = (config: ProductionConfig): void => {
  if (config.staticDir !== undefined) return; // someone else's build
  const stale = webBuildStaleness();
  if (stale === undefined) return;
  say(`[repcoach] building the web client (${stale})…`);
  // Run Vite directly rather than through pnpm, which a service's PATH may not have.
  const vite = path.join(WEB_DIR, "node_modules", "vite", "bin", "vite.js");
  const result = spawnSync(process.execPath, [vite, "build"], { cwd: WEB_DIR, stdio: "inherit" });
  if (result.status !== 0) fail(`web client build failed (exit ${String(result.status)})`);
};

const openInBrowser = (url: string): void => {
  const [file, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    say(`[repcoach] could not open a browser — open this yourself: ${url}`);
  }
};

const fetchIdentity = async (port: number): Promise<ServerIdentity | undefined> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${SERVER_WELL_KNOWN_PATH}`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok ? ((await response.json()) as ServerIdentity) : undefined;
  } catch {
    return undefined;
  }
};

/** The running server, confirmed by asking it rather than trusting a pid that may have been reused. */
const findRunningServer = async (config: ProductionConfig): Promise<RuntimeState | undefined> => {
  const state = readRuntimeState(config.dbPath);
  if (state === undefined) return undefined;
  const identity = await fetchIdentity(state.port);
  return identity?.instanceId === state.instanceId ? state : undefined;
};

/** A pairing link into this machine's browser, landing on Settings. */
const localSettingsLink = (config: ProductionConfig, port: number): string => {
  const { code } = mintPairingCode(readOrCreateServerSecret(dataDirFor(config)));
  return `http://127.0.0.1:${port}/pair#code=${encodeURIComponent(code)}&next=${encodeURIComponent("/settings#server")}`;
};

const start = async (config: ProductionConfig, options: { readonly open: boolean }): Promise<void> => {
  await assertNodeSqlite();
  const running = await findRunningServer(config);
  if (running !== undefined) {
    if (options.open) {
      say(`[repcoach] the server is already running (pid ${running.pid}, port ${running.port}) — opening Settings.`);
      openInBrowser(localSettingsLink(config, running.port));
      return;
    }
    fail(`the server is already running (pid ${running.pid}, port ${running.port}${running.managed ? ", background service" : ""}).`);
  }
  ensureWebBuild(config);
  const server = await startProductionServer(config);
  exitOnSignals(server);
  if (options.open) {
    say("[repcoach] opening Settings in your browser — phone access, pairing and the background service are there.");
    say("[repcoach] keep this window open until you install the background service; closing it stops the server.");
    openInBrowser(localSettingsLink(config, server.port));
  }
};

const pair = async (config: ProductionConfig): Promise<void> => {
  const running = await findRunningServer(config);
  const identity = running === undefined ? undefined : await fetchIdentity(running.port);
  const base = identity?.phoneUrl ?? (running === undefined ? undefined : `http://127.0.0.1:${running.port}/`);
  if (base === undefined) {
    return fail("the server is not running. Start it with `pnpm repcoach install` first.");
  }
  const { code, expiresAt } = mintPairingCode(readOrCreateServerSecret(dataDirFor(config)));
  const url = new URL(`/pair#code=${encodeURIComponent(code)}`, base).toString();
  say("Scan this with the device you want to pair, or open the link on it:");
  say();
  say(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  say(url);
  say();
  say(`Works once, until ${new Date(expiresAt).toLocaleTimeString()}. Treat it like a password.`);
  if (identity?.phoneUrl == null) {
    say("Note: Tailscale Serve is not fronting the server yet, so this link only works on this machine. See `pnpm repcoach status`.");
  }
};

const status = async (config: ProductionConfig): Promise<void> => {
  const running = await findRunningServer(config);
  const identity = running === undefined ? undefined : await fetchIdentity(running.port);
  const service = await serviceManagerFor(config).status();
  if (running === undefined) {
    say("Server:          not running");
  } else {
    say(`Server:          running — pid ${running.pid}, http://127.0.0.1:${running.port}, since ${new Date(running.startedAt).toLocaleString()}`);
    say(`Started by:      ${running.managed ? "the background service" : "hand (stops when its window closes)"}`);
    say(`Phone URL:       ${identity?.phoneUrl ?? "none yet — open Settings for what to fix"}`);
  }
  say(
    `Service:         ${service.kind === null ? "not supported here" : service.installed ? `installed (${service.kind})` : "not installed"}`,
  );
  if (service.logPath !== null) say(`Log:             ${service.logPath}`);
  for (const legacy of service.legacy) say(`Old launcher:    ${legacy}`);
  say(`Data:            ${dataDirFor(config)}`);
};

const [command = "start", ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
const config = productionConfigFromEnv();

switch (command) {
  case "install":
    await start(config, { open: !rest.includes("--no-open") });
    break;
  case "start":
    await start(config, { open: rest.includes("--open") });
    break;
  case "pair":
    await pair(config);
    break;
  case "status":
    await status(config);
    break;
  default:
    fail(`unknown command "${command}". Commands: install, start, pair, status.`);
}

