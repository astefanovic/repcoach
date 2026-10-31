import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { expectConnected, resetServer, setOffline } from "../driver.ts";

const DEV_SERVER_HTTP_URL = "http://127.0.0.1:4010";

/**
 * A workout does not come back empty after the page reloads.
 *
 * The real-world trigger is the phone discarding a backgrounded tab and
 * reloading it when the user returns mid-workout. Before the fix, Sets the
 * server had already acknowledged were gone from the reloaded surface — rows
 * back to `Log as prescribed`, the footer back to `0 of 6 sets logged` — and
 * only came back once the user went back to Today and resumed. So every claim
 * here is made on the SAME logging URL, with no detour through Today:
 *
 * - the Sets logged before the reload read `Logged` again after it;
 * - the counter and the footer count them;
 * - the header's `offline copy` marker — shown only while the app is drawing
 *   a cached copy — does not stay up once the reloaded page has reconnected;
 * - the server still holds exactly the Sets it held, once each (the reload
 *   must not replay or drop anything).
 *
 * The small "✓ logs …" line that used to sit under each row's values is gone
 * (UAT); its absence is asserted on every screen this file reaches.
 *
 * Handles are visible text and accessible names only, per
 * docs/agents/testing.md; text is matched case-insensitively.
 */

const CONFIRM_NAME = /^(Log as prescribed|Logged)$/;
const confirms = (page: Page) => page.getByRole("button", { name: CONFIRM_NAME });

/** Seeded Session 1 read top to bottom: Back Squat ×2, Bench Press, Plank, Leg Press, its drop. */
const SET = { squatFirst: 0, squatSecond: 1, bench: 2, plank: 3, legPress: 4, legPressDrop: 5 } as const;

/** The retired under-value hint, in any of its old forms. */
const OLD_HINT = /✓ logs|logs \d/i;

type LoggedActual = {
  readonly commandId: string;
  readonly setId: string;
  readonly actual: { readonly reps?: number; readonly load?: number; readonly duration?: number };
};

const readActuals = async (request: APIRequestContext): Promise<readonly LoggedActual[]> => {
  const response = await request.get(`${DEV_SERVER_HTTP_URL}/__test__/logged-actuals`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { readonly actuals: readonly LoggedActual[] }).actuals;
};

const openLogging = async (page: Page) => {
  await page.goto("/");
  await expectConnected(page);
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Session 1/ }).click();
  await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/0\s*\/\s*6/)).toBeVisible();
};

/** The rest pill sits over the bottom rows; Skip is a user action that clears it. */
const skipRest = async (page: Page) => {
  const skip = page.getByRole("button", { name: /^skip$/i }).first();
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
  }
};

const logSet = async (page: Page, index: number) => {
  await confirms(page).nth(index).click();
  await expect(confirms(page).nth(index)).toHaveAccessibleName("Logged");
  await skipRest(page);
};

test.describe("a reload keeps the workout's logged Sets", () => {
  test.beforeEach(async ({ request }) => {
    await resetServer(request);
  });

  test.afterEach(async ({ request, context }) => {
    await setOffline(context, false);
    await resetServer(request);
  });

  test("Sets the server has acknowledged are still logged after a reload, without leaving the page", async ({
    page,
    request,
  }) => {
    await openLogging(page);
    const loggingUrl = page.url();
    expect(loggingUrl).toMatch(/\/log\//);

    await logSet(page, SET.squatFirst);
    await logSet(page, SET.bench);
    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();

    // The server has them — this is the precondition the bug needed: the
    // acknowledged Sets, not merely queued ones, are what vanished.
    await expect.poll(async () => (await readActuals(request)).length, { timeout: 20_000 }).toBe(2);
    const before = await readActuals(request);

    await page.reload();

    // Same page — the reload must not bounce the user to Today, and they must
    // not have to go there to get their Sets back.
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
    expect(page.url()).toBe(loggingUrl);

    await expect(confirms(page)).toHaveCount(6);
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Logged");
    await expect(confirms(page).nth(SET.bench)).toHaveAccessibleName("Logged");
    await expect(confirms(page).nth(SET.squatSecond)).toHaveAccessibleName("Log as prescribed");
    await expect(confirms(page).nth(SET.plank)).toHaveAccessibleName("Log as prescribed");
    await expect(page.getByRole("button", { name: "Logged", exact: true })).toHaveCount(2);
    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();
    await expect(page.getByText(/2\s*\/\s*6/)).toBeVisible();

    // The logged values read back as logged, not as a fresh prescription.
    await expect(page.getByRole("button", { name: /^reps — logged 5\b/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^reps — logged 10\b/ })).toHaveCount(1);

    // Reconnected, the header is not still claiming a cached copy.
    await expectConnected(page);
    await expect(page.getByText(/offline copy/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);

    // And still exactly what it was server-side: nothing replayed, nothing lost.
    await page.waitForTimeout(1_000);
    const after = await readActuals(request);
    expect(after.map((entry) => entry.commandId).sort()).toEqual(
      before.map((entry) => entry.commandId).sort(),
    );
  });

  test("the reloaded workout carries on: a Set logged after the reload adds to the ones before it", async ({
    page,
    request,
  }) => {
    await openLogging(page);
    await logSet(page, SET.squatFirst);
    await logSet(page, SET.squatSecond);
    await expect.poll(async () => (await readActuals(request)).length, { timeout: 20_000 }).toBe(2);

    await page.reload();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();
    await expectConnected(page);

    // The count goes 2 → 3, not 0 → 1: the reloaded surface is the same
    // workout, not a blank one the old Sets have to be merged back into.
    await logSet(page, SET.plank);
    await expect(page.getByText(/3 of 6 sets logged/i)).toBeVisible();
    await expect(page.getByText(/3\s*\/\s*6/)).toBeVisible();
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Logged");
    await expect(confirms(page).nth(SET.squatSecond)).toHaveAccessibleName("Logged");

    await expect.poll(async () => (await readActuals(request)).length, { timeout: 20_000 }).toBe(3);
    const actuals = await readActuals(request);
    expect(new Set(actuals.map((entry) => entry.setId)).size).toBe(3);
    expect(actuals.map((entry) => entry.actual)).toEqual(
      expect.arrayContaining([{ reps: 5, load: 100 }, { reps: 5, load: 100 }, { duration: 45 }]),
    );
    await expect(page.getByText(OLD_HINT)).toHaveCount(0);
  });

  test("Sets captured offline and delivered on reconnect survive a later reload", async ({
    page,
    request,
    context,
  }) => {
    await openLogging(page);

    await setOffline(context, true);
    await logSet(page, SET.squatFirst);
    await logSet(page, SET.legPress);
    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();
    expect(await readActuals(request)).toHaveLength(0);

    await setOffline(context, false);
    await expectConnected(page);
    await expect.poll(async () => (await readActuals(request)).length, { timeout: 30_000 }).toBe(2);

    await page.reload();
    await expect(page.getByRole("button", { name: "Back to Today" })).toBeVisible({ timeout: 20_000 });
    await expect(confirms(page).nth(SET.squatFirst)).toHaveAccessibleName("Logged");
    await expect(confirms(page).nth(SET.legPress)).toHaveAccessibleName("Logged");
    await expect(page.getByText(/2 of 6 sets logged/i)).toBeVisible();

    await expectConnected(page);
    await expect(page.getByText(/offline copy/i)).toHaveCount(0, { timeout: 15_000 });
    expect(await readActuals(request)).toHaveLength(2);
  });
});
