import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline, snapshotText } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * The rest timer (issue #21, re-derived for #82 item 4).
 *
 * Skipped by #50 against a fixture-driven Logging surface, and — as its own
 * note warned — the timer moved while it was away. #63 took it off the band
 * under the status strip, which had put system state and workout state in two
 * coloured single-line bands ~24px apart, and made it **a pill pinned to the
 * bottom of the surface**, in the thumb arc, floating over content instead of
 * pushing it. So `rest-timer` / `rest-timer-complete` are not restored here;
 * the pill is located the way a user locates it, by its own controls and its
 * own text.
 *
 * What this file proves:
 *
 * - **The pill auto-starts on confirm**, with no separate "start rest" tap.
 *   Rest begins when the set ends; asking the user to say so again is a tap
 *   they will forget while breathing hard.
 * - **It sits at the bottom.** That is the whole content of #63's decision on
 *   this control, so it is asserted geometrically — the pill's own controls
 *   are in the lower half of the viewport, at the opposite end from the
 *   status strip. Nothing else on this surface would notice if the pill
 *   drifted back up under the strip, which is exactly why it is checked.
 * - **It names what you are resting from**, so a pill glimpsed mid-set is
 *   unambiguous when two exercises are being alternated.
 * - **The countdown drains inside the pill**, and drains from the *prescribed*
 *   duration — Back Squat prescribes 2:00 and that is where it starts.
 * - **It runs with the network down.** Rest is computed from the cached
 *   prescription; it is not a server-side clock, and ADR 0009's gate 1 means a
 *   basement gym must not cost the user their rest timer.
 * - **When neither the Set nor its Entry prescribes rest, the pill never
 *   appears** (#63, and ui-surfaces.md's "if the Plan doesn't track rest, no
 *   timer — no forced default"). The seed's Leg Press is the negative case:
 *   its prescribed drop continuation carries no rest of its own and inherits
 *   no Entry-level default, so confirming it must leave the bottom of the
 *   screen empty. A forced default here would be the app inventing training
 *   prescription the user never wrote.
 * - **`+30s` and `Skip` do what they say** — the two escapes from a
 *   prescription that turned out wrong in the moment, in both directions.
 * - **It survives zero** (#113 item 2). At 0:00 the pill used to vanish, which
 *   is exactly when the user looks at their phone; it now counts *up* and
 *   reads `-0:07`, and only Skip (or the next confirmed set) takes it away.
 * - **Correcting an already-logged set does not restart it** (#113 item 1) —
 *   fixing a load on a set finished twenty minutes ago is a correction, not a
 *   set completion, and the user is not resting from it.
 *
 * The countdown is read out of the page's visible text rather than by walking
 * to it: the pill renders as `1:59` above `REST · BACK SQUAT`, and matching
 * *time-then-label* is what keeps this from colliding with the Entry headers,
 * which read the other way round (`REST 2:00`).
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

/** Prescribed order down the screen; see log-straight-session.spec.ts. */
const SET = { squatFirst: 0, legPressDrop: 5 } as const;

/** The pill's own controls — the cheapest nameable proof that it is on screen. */
const skipRest = (page: Page) => page.getByRole("button", { name: /^skip$/i });
const extendRest = (page: Page) => page.getByRole("button", { name: /\+\s*30\s*s$/i });

/**
 * Seconds on the pill, read off the rendered text and **signed**: past zero
 * the clock reads `-0:07`, and a reader that dropped the sign would report an
 * overrunning timer as one that had restarted.
 */
const readPillSeconds = async (page: Page): Promise<number | undefined> => {
  const body = (await snapshotText(page)).replace(/\s+/g, " ");
  const match = /(-|−)?(\d{1,2}):(\d{2}) rest ·/i.exec(body);
  if (match === null) return undefined;
  const seconds = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === undefined ? seconds : -seconds;
};

/**
 * Rewrites the seeded prescribed rest down to a few seconds, server-side
 * (#113 item 2), and answers with the value it wrote. Called BEFORE the client
 * loads, because the timer runs off the prescription the client prefetched and
 * cached — a shortening that landed afterwards would change nothing on screen.
 */
const shortenPrescribedRest = async (request: APIRequestContext): Promise<number> => {
  const response = await request.post(`${DEV_SERVER_HTTP_URL}/__test__/shorten-rest`);
  const body = (await response.json()) as { readonly shortened: boolean; readonly restSec: number };
  expect(body.shortened).toBe(true);
  return body.restSec;
};

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  // The whole session row is the button; see log-straight-session.spec.ts.
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

test.describe("rest timer", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("confirming a set with prescribed rest raises a bottom-pinned pill that names the exercise and counts down", async ({
    page,
  }) => {
    await openLogging(page);

    // Nothing before the set is confirmed: the pill is a consequence of
    // finishing work, not furniture.
    await expect(skipRest(page)).toHaveCount(0);

    await confirms(page).nth(SET.squatFirst).click();

    // Auto-started, and it says what it is resting from.
    await expect(skipRest(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/rest\s*·\s*back squat/i)).toBeVisible();

    // Draining from the prescription: Back Squat prescribes 2:00, so the pill
    // opens at 120s and not at some house default.
    const opening = await readPillSeconds(page);
    expect(opening).toBeGreaterThan(110);
    expect(opening).toBeLessThanOrEqual(120);

    // And it actually runs.
    await expect
      .poll(async () => readPillSeconds(page), { timeout: 15_000 })
      .toBeLessThan(opening ?? 0);

    // Bottom-pinned (#63). Asserted against the viewport rather than against
    // any element, because the claim is about where the user's thumb finds it:
    // the opposite end of the screen from the status strip.
    const viewport = page.viewportSize();
    const pillBox = await skipRest(page).boundingBox();
    expect(viewport).not.toBeNull();
    expect(pillBox).not.toBeNull();
    expect(pillBox?.y ?? 0).toBeGreaterThan(((viewport?.height ?? 0) * 2) / 3);
  });

  test("the pill runs from the cached prescription with the network down", async ({
    page,
    context,
  }) => {
    await openLogging(page);

    // Real offline, via CDP. Rest duration is a prescription attribute the
    // client already holds; if the timer were asking the server for anything,
    // this is where it would stop working.
    await setOffline(context, true);

    await confirms(page).nth(SET.squatFirst).click();
    await expect(skipRest(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/rest\s*·\s*back squat/i)).toBeVisible();

    const opening = await readPillSeconds(page);
    expect(opening).toBeGreaterThan(110);
    await expect
      .poll(async () => readPillSeconds(page), { timeout: 15_000 })
      .toBeLessThan(opening ?? 0);

    // And losing the network is not an error condition on this surface — the
    // set is captured, the rest is running, and the user is told nothing they
    // cannot act on (ADR 0009 gate 1).
    const offlineText = (await snapshotText(page)).toLowerCase();
    expect(offlineText).not.toContain("error");
    expect(offlineText).not.toContain("failed");
  });

  test("when neither the Set nor its Entry prescribes rest, no pill appears", async ({ page }) => {
    await openLogging(page);

    // The Leg Press drop continuation: no rest of its own, and no Entry-level
    // default to inherit. Confirmed on a clean surface so nothing else could
    // be responsible for a pill.
    await confirms(page).nth(SET.legPressDrop).click();
    await expect(confirms(page).nth(SET.legPressDrop)).toHaveAccessibleName("Logged");

    // A real beat before the negative assertion. The pill appears
    // asynchronously on confirm, so a bare `toHaveCount(0)` would pass
    // instantly and prove nothing at all — the same instrument, and the same
    // reasoning, as the cancelled-while-queued assertion in
    // revise-a-proposal.spec.ts.
    await page.waitForTimeout(4_000);

    await expect(skipRest(page)).toHaveCount(0);
    await expect(extendRest(page)).toHaveCount(0);
    await expect(page.getByText(/rest\s*·/i)).toHaveCount(0);
  });

  test("+30s extends the countdown and Skip dismisses the pill", async ({ page }) => {
    await openLogging(page);

    await confirms(page).nth(SET.squatFirst).click();
    await expect(skipRest(page)).toBeVisible({ timeout: 10_000 });

    // Extending: the prescription is a starting point, not a contract. The
    // countdown is live, so this is a comparison against a fresh reading with
    // room for a second of drain, not an exact arithmetic check.
    const before = await readPillSeconds(page);
    await extendRest(page).click();
    await expect.poll(async () => readPillSeconds(page), { timeout: 10_000 }).toBeGreaterThan(
      (before ?? 0) + 20,
    );

    // Skipping: the pill goes away entirely rather than sitting at zero.
    await skipRest(page).click();
    await expect(skipRest(page)).toHaveCount(0);
    await expect(page.getByText(/rest\s*·\s*back squat/i)).toHaveCount(0);

    // Skipping rest is not un-logging the set — the two controls are on
    // opposite ends of the screen and must stay independent.
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Logged");
  });

  /**
   * #63 said the pill "vibrates and dismisses at zero", and this file carried
   * a skipped test for the dismissal half — waiting on a way to reach a short
   * rest from outside the client, because a spec that idles two minutes to
   * watch a pill disappear is a spec that gets deleted the first time the
   * suite feels slow.
   *
   * #113 item 2 both granted the lever (`POST /__test__/shorten-rest`) and
   * **reversed the behaviour it was waiting to assert.** Dismissing at zero
   * hid the timer at exactly the moment the user looks at their phone; the
   * pill now survives zero and counts up, so "how far over am I" is
   * answerable. So the skipped test is gone and this is what replaces it.
   *
   * The vibration half is still not observable to Playwright and still belongs
   * to phone UAT, rung 3.
   */
  test("the pill survives zero and counts up, and only Skip takes it away", async ({
    page,
    request,
  }) => {
    const restSec = await shortenPrescribedRest(request);
    await openLogging(page);

    await confirms(page).nth(SET.squatFirst).click();
    await expect(skipRest(page)).toBeVisible({ timeout: 10_000 });

    // Opens at whatever rest the (now shortened) prescription says.
    expect(await readPillSeconds(page)).toBeLessThanOrEqual(restSec);

    // The colour the countdown wears while it is still counting DOWN, kept so
    // the overrun can be held to it below.
    const clock = page.getByText(/^(-|−)?\d{1,2}:\d{2}$/).first();
    const colourWhileCountingDown = await clock.evaluate(
      (node) => getComputedStyle(node).color,
    );

    // Past zero the clock goes NEGATIVE rather than the pill going away —
    // both halves matter, so both are asserted: the reading is below zero and
    // the pill's own controls are still on screen.
    await expect
      .poll(async () => readPillSeconds(page), { timeout: 20_000 })
      .toBeLessThan(0);
    await expect(skipRest(page)).toBeVisible();
    await expect(page.getByText(/rest\s*·\s*back squat/i)).toBeVisible();

    // And it keeps counting up rather than parking at -0:01.
    const over = (await readPillSeconds(page)) ?? 0;
    await expect
      .poll(async () => readPillSeconds(page), { timeout: 15_000 })
      .toBeLessThan(over);

    // The overrun is not a deviation. Yellow is spent on missing the
    // prescription, and taking longer over your rest than the Plan suggested
    // is not that — so the clock keeps exactly the colour it wore while it was
    // counting down, rather than being promoted to a warning.
    expect(await clock.evaluate((node) => getComputedStyle(node).color)).toBe(
      colourWhileCountingDown,
    );

    // Skip is the only exit, and it still works from an overrun timer.
    await skipRest(page).click();
    await expect(skipRest(page)).toHaveCount(0);
    await expect(page.getByText(/rest\s*·\s*back squat/i)).toHaveCount(0);
  });

  /**
   * #113 item 1. Correcting a set logged minutes ago is a *correction*, not a
   * set completion — the user is not resting from it, and the app must not
   * claim they are. The bug was one unconditional call, invisible to every
   * other flow in this file because they all confirm a set they had not
   * confirmed before.
   *
   * Asserted as "the countdown did not jump back up", which is the thing the
   * user would actually see: a pill that had drained to 1:52 snapping back to
   * 2:00.
   */
  test("correcting an already-logged set does not restart the rest timer", async ({ page }) => {
    await openLogging(page);

    await confirms(page).nth(SET.squatFirst).click();
    await expect(skipRest(page)).toBeVisible({ timeout: 10_000 });

    // Let it drain far enough that a restart could not be mistaken for drift.
    await expect.poll(async () => readPillSeconds(page), { timeout: 20_000 }).toBeLessThan(115);
    const beforeEdit = (await readPillSeconds(page)) ?? 0;

    // The correction: tap the logged load, nudge it, save. This is the whole
    // of "editing a set" on this surface — there is no edit mode.
    await page.getByRole("button", { name: /^load — logged/ }).first().click();
    await page.getByRole("button", { name: "Increase load" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("button", { name: "Increase load" })).toHaveCount(0);

    // Still the same rest, still draining — not a fresh 2:00.
    const afterEdit = (await readPillSeconds(page)) ?? 0;
    expect(afterEdit).toBeLessThanOrEqual(beforeEdit);
    await expect
      .poll(async () => readPillSeconds(page), { timeout: 15_000 })
      .toBeLessThan(afterEdit);
  });
});
