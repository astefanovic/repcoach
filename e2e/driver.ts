import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

/**
 * Rung-2 browser driver primitives shared by every acceptance flow.
 *
 * Intentionally thin: flows are black-box (assert on visible text /
 * accessibility roles only, per the adversarial-author contract in
 * docs/design/thin-client-implementation-plan.md). This module supplies the
 * one thing Maestro-on-a-device cannot: real network control via CDP, so
 * later tasks (G1/G2) can force true offline / restore it mid-flow.
 */

/**
 * Force the browser context offline/online via Playwright's CDP-backed
 * `setOffline`. This is the same primitive used for G1 (offline capture) and
 * G2 (blip transparency) in later tasks — Task 0 only proves it runs without
 * error and actually flips network state.
 */
export async function setOffline(context: BrowserContext, offline: boolean): Promise<void> {
  await context.setOffline(offline);
}

/** Snapshot the rendered DOM text content, for black-box text assertions. */
export async function snapshotText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/**
 * The status strip's vocabulary (#50).
 *
 * The client no longer has a `connection-indicator` element reading
 * "Connected" / "Not connected to home" — that text existed only because the
 * UI was a stand-in. #42 replaced it with one persistent single-line strip,
 * and the strip is what a user actually reads, so it is what the flows assert.
 *
 * **These strings are deliberately in one place, and they are not settled.**
 * #42 settled the strip's semantics (neutral default, yellow on exception,
 * never red); the wording is a choice #50 made following the prototype's idiom
 * — see `apps/web/src/runtime/statusStrip.ts`. The adversarial e2e author owns
 * the black-box contract from #72 onward, when there are far more strip states
 * to name. Until then, a flow asserting connection state should reference these
 * rather than inlining a string, so re-naming is one edit.
 *
 * Matched as substrings, not equality: the strip appends a pending-set count
 * when the outbox is non-empty.
 */
export const STRIP = {
  /** Connected to home, nothing queued. */
  connected: "synced",
  /** Not connected to home, in either of its forms. */
  notConnected: "offline",
} as const;

/**
 * Wait for the strip to report connected. Replaces the
 * `expect(connectionIndicator).toHaveText("Connected")` step that opened every
 * pre-#50 flow.
 */
export async function expectConnected(page: Page, timeoutMs = 60_000): Promise<void> {
  await page
    .getByText(STRIP.connected, { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

/**
 * The dev-server's control channel. Published by `playwright.config.ts` so the
 * port moves with the agent mode; the literal is the canned-mode fallback the
 * flows used to inline one by one.
 */
const DEV_SERVER_HTTP_URL =
  process.env["REPCOACH_DEV_SERVER_HTTP_URL"] ?? "http://127.0.0.1:4010";

/**
 * Reset the dev-server to its seed — with a few attempts, because on this host
 * the *connect* is what fails, not the reset.
 *
 * Measured over full-suite runs: a probe opening a TCP connection to the
 * dev-server every 1.5s saw 13% of connects time out (>3s) while the server
 * process was alive, listening and idle — and 300 consecutive connects to a
 * trivial listener with the suite stopped all succeeded in under 24ms. So the
 * stall is load-dependent and below the application: an idle Node process
 * drains its accept queue immediately, and the dev-server peaked at four
 * established sockets.
 *
 * What that cost was almost entirely bookkeeping, not assertions. Across two
 * full runs, every `ETIMEDOUT` landed on this exact POST inside a
 * `beforeEach`/`afterEach` — failing tests whose own assertions had passed, in
 * teardown, after the fact. Retrying the connect is therefore not papering
 * over a product failure; it is refusing to report a host-level network blip
 * as a broken acceptance test.
 *
 * Deliberately narrow: only the reset call, only a few short attempts. A
 * dev-server that is genuinely down still fails, just a second later.
 */
export async function resetServer(request: APIRequestContext, attempts = 4): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await request.post(`${DEV_SERVER_HTTP_URL}/__test__/reset`, { timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error;
      // Linear, not exponential: the observed stalls are seconds, and a test
      // that cannot reset within ~3s of trying has a real problem to report.
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw lastError;
}
