import { expect, test } from "@playwright/test";

import { STRIP, expectConnected, resetServer } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * The G2 acceptance flow: blip transparency.
 *
 * Black-box only: this flow never reaches into client internals. It drives the
 * web client to a visible connected state, then uses the dev-server's
 * `/__test__/drop-socket` control channel (an external lever on the *server*,
 * per the adversarial-author contract) to force-close the live WebSocket while
 * the browser's own network stays up. A sub-30s transport blip must be
 * invisible to the user: the UI recovers within the supervisor's backoff window
 * (`[1,2,4,8,16]s`, well under 30s) and never surfaces an error string.
 *
 * Repointed at `apps/web` by #50, which also changed *what* it reads. There is
 * no longer a `connection-indicator` element saying "Connected" — #42 replaced
 * it with the persistent status strip, so the flow asserts the strip's text via
 * `driver.ts`'s `STRIP` vocabulary. What the flow *proves* is unchanged, and it
 * now proves it about the real thing: the DOM WebSocket adapter, the DOM
 * connectivity adapter, and the same vendored supervisor underneath both.
 */
test.describe("G2: blip transparency", () => {
  test.afterEach(async ({ request }) => {
    // Always leave the dev-server's store/control state clean for the next
    // test, even if an assertion above failed mid-flow.
    await resetServer(request);
  });

  test("recovers to connected after a socket drop, with no error surfaced", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    // 1. Reach connected against the real dev-server.
    await expectConnected(page);

    // 2. Induce a transport blip via the server's control channel — a lever
    // external to the client, never a hook in client internals.
    const response = await request.post(`${DEV_SERVER_HTTP_URL}/__test__/drop-socket`);
    expect(response.ok()).toBe(true);

    // 3. The blip is real (the supervisor's socket did close) — the strip is
    // allowed to transiently show the offline state...
    // 4. ...but must recover well within the backoff window (retry schedule
    // tops out at 16s per attempt; 30s is the stable-reset threshold), and at
    // no point may an error string appear in the DOM.
    await expectConnected(page, 25_000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText.toLowerCase()).not.toContain("error");
    // The strip must not be *simultaneously* claiming both states — a
    // regression a substring match on "synced" alone would not catch.
    expect(bodyText).not.toContain(STRIP.notConnected);
  });
});
