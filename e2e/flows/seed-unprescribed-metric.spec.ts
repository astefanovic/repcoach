import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * Issue #149 — one tap on ✓ seeds a metric the prescription does not bound,
 * so the tap records the load lifted instead of a blank.
 *
 * The seed fixture bounds every load, so this flow first opens Session 1's
 * loads to `{}` ("report, no target") via the `/__test__/open-prescribed-load`
 * lever — the same shape of lever `shorten-rest` is, and for the same reason
 * (the rung-2 author is forbidden client hooks, docs/agents/testing.md).
 *
 * Two claims, both from the ticket's acceptance list:
 *
 * - **Tier 1 — within a session.** Type a load on the first Back Squat set;
 *   the second set's row then *shows* that number (as `~N`, before any tap),
 *   and one tap on ✓ writes it. "Shows it before the tap" is decision (a):
 *   the surface stays honest about what one tap does.
 * - **Tier 2 — across sessions.** Finish that workout, start Session 1 again;
 *   the first Back Squat set now shows the load carried over from last time,
 *   and one tap writes it. This is the cross-session read tier 1 never had.
 *
 * Every handle here is visible text or an accessible name.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

/** Load cells run down the screen in prescribed order: squat 1, squat 2, bench, leg press, leg-press drop. */
const loadCells = (page: Page) => page.getByRole("button", { name: /^load —/i });

type LoggedActual = {
  readonly setId: string;
  readonly actual: { readonly reps?: number; readonly load?: number };
};

const readActuals = async (request: APIRequestContext): Promise<readonly LoggedActual[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { readonly actuals: readonly LoggedActual[] };
  return body.actuals;
};

const openPrescribedLoad = async (request: APIRequestContext): Promise<void> => {
  const response = await request.post(`${DEV_SERVER_HTTP_URL}/__test__/open-prescribed-load`);
  expect(response.ok()).toBe(true);
  expect(((await response.json()) as { readonly opened: boolean }).opened).toBe(true);
};

const startSession1 = async (page: Page): Promise<void> => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
};

/** Open a load cell's editor, type `value`, and save. */
const typeLoad = async (page: Page, cellIndex: number, value: string): Promise<void> => {
  await loadCells(page).nth(cellIndex).click();
  const field = page.getByRole("textbox", { name: "load value" });
  await field.fill(value);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(field).toHaveCount(0);
};

test.describe("one-tap ✓ seeds an unprescribed metric (#149)", () => {
  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("tier 1: the next set of this Entry shows the load just typed, and one tap writes it", async ({
    page,
    request,
  }) => {
    await openPrescribedLoad(request);
    await startSession1(page);

    // The first Back Squat set: load is open ("report") with no earlier Set to
    // seed from. Typing the load and saving logs the set (reps from the
    // prescription, load from what was typed).
    await expect(loadCells(page).first()).toContainText(/report/i);
    await typeLoad(page, 0, "82.5");
    await expect(confirms(page).nth(0)).toHaveAccessibleName("Logged");

    // The SECOND set now carries that number as a seed — visible on the row,
    // as `~82.5`, before it is tapped. That is the decision (a) claim: the
    // tap is honest about what it writes.
    await expect(loadCells(page).nth(1)).toContainText("~82.5");
    await confirms(page).nth(1).click();

    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();
    await expect
      .poll(async () => (await readActuals(request)).length, { timeout: 20_000 })
      .toBe(2);

    const loads = (await readActuals(request)).map((entry) => entry.actual.load).sort();
    expect(loads).toEqual([82.5, 82.5]);
  });

  test("tier 2: a fresh workout seeds the first set from the last time the exercise was performed", async ({
    page,
    request,
  }) => {
    await openPrescribedLoad(request);

    // Workout 1: log a Back Squat set at 77.5 (typing the load logs it), then finish.
    await startSession1(page);
    await typeLoad(page, 0, "77.5");
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();
    await expectConnected(page);
    await page.getByRole("button", { name: /^finish session$/i }).click();
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Workout 2: the very first Back Squat set is seeded from last time —
    // shown as `~77.5` before any tap — and one tap records it.
    await startSession1(page);
    await expect(loadCells(page).first()).toContainText("~77.5");
    await confirms(page).nth(0).click();
    await expect(page.getByText(/1 of 6 sets logged/i)).toBeVisible();

    // Two actuals now carry load 77.5 — workout 1's, and the one workout 2's
    // single tap just wrote from the seed.
    await expect
      .poll(
        async () =>
          (await readActuals(request)).filter(
            (entry) => entry.actual.load === 77.5 && entry.actual.reps === 5,
          ).length,
        { timeout: 20_000 },
      )
      .toBe(2);
  });
});
