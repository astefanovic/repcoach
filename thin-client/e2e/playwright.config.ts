import { defineConfig } from "@playwright/test";

/**
 * Which agents this run exercises (issue #95): `canned` (the default and what
 * CI runs), `replay` (the real adapters over recorded transcripts) or `live`
 * (the real adapters over real Agent SDK sessions).
 *
 * The mode reaches the dev-server through its own environment, so no source
 * changes anywhere select it — but it also moves BOTH ports. That is not
 * fussiness: `reuseExistingServer` is on, and a dev-server already listening on
 * 4010 with canned agents would be silently reused for a replay run, producing
 * a green suite that never touched an agent. A different port cannot be
 * mistaken for the canned one, and the Vite client has to move with it because
 * its server URL is baked in at boot.
 */
const AGENT_MODE = process.env["REPCOACH_AGENT_MODE"]?.trim() ?? "canned";
const AGENT_BACKED = AGENT_MODE !== "canned";

const WEB_PORT = AGENT_BACKED ? 5174 : 5173;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const DEV_SERVER_PORT = AGENT_BACKED ? 4011 : 4010;
const DEV_SERVER_HTTP_URL = `http://127.0.0.1:${DEV_SERVER_PORT}`;

// Published to the test processes so a flow can reach the control channel
// without hard-coding a port that moves with the mode. The canned flows
// predate this and still inline `http://127.0.0.1:4010`, which is correct for
// them: they only ever run in canned mode.
process.env["REPCOACH_DEV_SERVER_HTTP_URL"] = DEV_SERVER_HTTP_URL;

/**
 * A live agent session is minutes, not milliseconds (#93 recorded ~60–90s for a
 * cold Intake draft and 2–4 for a convergence sweep), so the per-test budget
 * has to move with the mode. Replay is as fast as canned.
 */
const TEST_TIMEOUT_MS = AGENT_MODE === "live" ? 15 * 60_000 : 60_000;

export default defineConfig({
  testDir: "./flows",
  timeout: TEST_TIMEOUT_MS,
  fullyParallel: false,
  workers: 1,
  /**
   * One retry, so a flake and a regression stop looking identical.
   *
   * At zero — the default, and what this suite ran at — a single timing blip
   * anywhere turned the whole run red, and the only way to tell "flaked once"
   * from "broken" was to re-run the spec by hand and see. That is a slow way
   * to lose trust in rung 2, and the cost is asymmetric: a genuinely broken
   * spec still fails twice and still reports, while a flake is reported as
   * *flaky* rather than swallowed. Playwright surfaces retried passes
   * explicitly, so this buys signal rather than hiding failure.
   *
   * Deliberately 1 and not 2: the point is to distinguish the two cases, not
   * to grind a real failure into a pass.
   */
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
  },
  // Launches both the dev-server and the web client so
  // `pnpm --filter @repcoach/e2e test` is a single self-contained command
  // (mirrors rung-2 being runnable in CI without a human starting either
  // server by hand first). The G2 blip-transparency flow needs a live server
  // to connect to and drop-socket against.
  //
  // Repointed from Expo web to the Vite client by #50. Two things got better
  // for free: no ~90s cold Metro bundle (Vite dev boots in about a second, so
  // the 120s timeout drops to 60s), and no `expo export` white-screen bug in
  // the path at all (#47).
  webServer: [
    {
      command: "pnpm --filter @repcoach/dev-server dev",
      cwd: "..",
      // The dev-server has no `GET /` route (only `/rpc` and `/__test__/*`),
      // so it 404s — Playwright's `url` probe requires a 2xx/3xx to consider
      // the server ready. `port` just waits for the TCP listener instead.
      port: DEV_SERVER_PORT,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        PORT: String(DEV_SERVER_PORT),
        // Forwarded verbatim: the dev-server owns what each of these means
        // (`agentMode.ts`), and a harness that re-interpreted them would be a
        // second place the mode could be wrong.
        ...(process.env["REPCOACH_AGENT_MODE"] === undefined
          ? {}
          : { REPCOACH_AGENT_MODE: process.env["REPCOACH_AGENT_MODE"] }),
        ...(process.env["REPCOACH_AGENT_CASSETTE_DIR"] === undefined
          ? {}
          : { REPCOACH_AGENT_CASSETTE_DIR: process.env["REPCOACH_AGENT_CASSETTE_DIR"] }),
        ...(process.env["REPCOACH_AGENT_RECORD_DIR"] === undefined
          ? {}
          : { REPCOACH_AGENT_RECORD_DIR: process.env["REPCOACH_AGENT_RECORD_DIR"] }),
        ...(process.env["REPCOACH_AGENT_ALLOW_STALE_CASSETTES"] === undefined
          ? {}
          : { REPCOACH_AGENT_ALLOW_STALE_CASSETTES: process.env["REPCOACH_AGENT_ALLOW_STALE_CASSETTES"] }),
        ...(process.env["REPCOACH_AGENT_MAX_SESSIONS"] === undefined
          ? {}
          : { REPCOACH_AGENT_MAX_SESSIONS: process.env["REPCOACH_AGENT_MAX_SESSIONS"] }),
        ...(process.env["REPCOACH_AGENT_MAX_COST_USD"] === undefined
          ? {}
          : { REPCOACH_AGENT_MAX_COST_USD: process.env["REPCOACH_AGENT_MAX_COST_USD"] }),
      },
    },
    {
      command: `pnpm --filter @repcoach/web dev --port ${WEB_PORT} --strictPort`,
      cwd: "..",
      url: WEB_URL,
      reuseExistingServer: true,
      timeout: 60_000,
      // The harness is deliberately cross-origin (client on :5173, server on
      // :4010), so it sets the env overrides rather than relying on the
      // same-origin path. Both are set on purpose: `resolveServerBaseUrls`
      // takes the env branch if *either* is present, and the other would then
      // fall back to a default rather than to the origin.
      env: {
        VITE_DEV_SERVER_HTTP_URL: DEV_SERVER_HTTP_URL,
        VITE_DEV_SERVER_WS_URL: `ws://127.0.0.1:${DEV_SERVER_PORT}`,
      },
    },
  ],
});
