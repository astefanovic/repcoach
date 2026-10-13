import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Headroom for the real-socket integration suites under ambient machine
    // load (chiefly the always-on home server on :4020). `waitForServerReady()`
    // is a bounded TCP-connect readiness probe that waits out a briefly-starved
    // accept loop (hookTimeout); the production-durability restart boots two
    // servers over one DB file (testTimeout).
    //
    // IMPORTANT: run the suite via `pnpm test` (scripts/run-tests.mjs), NOT a
    // bare `vitest run`. The real-socket suites are reliable ONLY when each runs
    // in its OWN vitest process: a single full-suite run shares one parent
    // process whose esbuild transform for every file starves the socket forks'
    // loopback accept loop → `connect ETIMEDOUT` / hung 30s connects. The runner
    // gives each socket file its own invocation. `waitForServerReady()` +
    // `fetchWithRetry`/`openWebSocketWithRetry` then absorb any residual
    // brief starvation. See the `test-flakiness-socket-suites` memory note.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // `apps/web` joins rung 1 with #50. Only its *pure* logic is tested here —
    // the `environment: "node"` above means there is no DOM, deliberately: the
    // IndexedDB and connectivity adapters are proven by the Playwright flows in
    // a real browser, which is the honest place for them.
    include: [
      "packages/**/*.test.ts",
      "apps/dev-server/**/*.test.ts",
      "apps/web/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.expo/**",
      "e2e/**",
    ],
  },
});
